require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require("@smithy/node-http-handler");
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// SECURITY: Helmet headers
app.use(helmet());

// SECURITY: Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Limit each IP to 1000 requests per windowMs
    message: { error: "Too many requests from this IP, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
});
// app.use(limiter); // User requested infinite requests, so rate limiter is disabled

// SECURITY: CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

app.use(express.json());

// CONFIGURATION (Moved to Environment Variables)
const MONGO_URI = process.env.MONGO_URI;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const BUCKET_NAME = process.env.BUCKET_NAME || "foodi";
const APP_API_KEY = process.env.APP_API_KEY;

if (!MONGO_URI || !APP_API_KEY) {
    console.error("❌ CRITICAL: Missing required environment variables (MONGO_URI or APP_API_KEY)");
    process.exit(1);
}

console.log("🚀 Server starting...");


// CLIENTS
const mongoClient = new MongoClient(MONGO_URI);

// R2 Endpoint temizleme (SSL hatalarını önlemek için)
let cleanEndpoint = R2_ENDPOINT.trim();
if (!cleanEndpoint.startsWith('http')) cleanEndpoint = `https://${cleanEndpoint}`;
// Eğer sonunda /foodi veya / kova adı varsa temizle
cleanEndpoint = cleanEndpoint.replace(/\/+$/, '').replace(/\/[a-zA-Z0-9._-]+$/, (match) => {
    // Sadece /foodi gibi kısımları, eğer .com veya .net sonrası geliyorsa temizle
    return match.includes('cloudflarestorage.com') ? match : '';
});
// Daha basit ve kesin yöntem: Sadece hostname kısmını al
try {
    const url = new URL(cleanEndpoint);
    cleanEndpoint = `${url.protocol}//${url.hostname}`;
} catch (e) {
    console.warn("⚠️ Endpoint URL parse hatası, ham değer kullanılıyor.");
}

const s3Client = new S3Client({
    region: "auto",
    endpoint: cleanEndpoint,
    forcePathStyle: true,
    credentials: {
        accessKeyId: R2_ACCESS_KEY,
        secretAccessKey: R2_SECRET_KEY,
    },
});

// SECURITY: API KEY
// Moved to process.env.APP_API_KEY

function authenticate(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    // Allow public access to ping
    if (req.path === '/ping') return next();
    
    if (apiKey && apiKey === APP_API_KEY) {
        next();
    } else {
        console.warn(`🚨 Unauthorized access attempt from IP: ${req.ip} for path: ${req.path}`);
        res.status(401).json({ error: "Unauthorized access. Invalid API Key." });
    }
}

app.use(authenticate);

function getCategoryQuery(category) {
    const cat = category.toLowerCase();
    if (cat === 'all') return {};
    if (cat === 'gastro') return { c: { $regex: '^gastro$', $options: 'i' } };
    if (cat === 'chef_pro' || cat === 'chef' || cat.includes('chef')) {
        return { c: { $regex: '^chef_pro$', $options: 'i' } };
    }
    if (cat === 'main') {
        return { c: { $regex: 'Main Dishes|Et Yemekleri|Tavuk Yemekleri|Balık Yemekleri|Kebap|Köfte|Sebze Yemekleri|Dolma-Sarma|Bakliyat|Pilav|Makarna', $options: 'i' } };
    } else if (cat === 'appetizer') {
        return { c: { $regex: 'Appetizer', $options: 'i' } };
    } else if (cat === 'breakfast') {
        return { c: { $regex: 'Breakfast', $options: 'i' } };
    } else if (cat === 'sauce') {
        return { c: { $regex: 'Sauce|Sos', $options: 'i' } };
    } else if (cat === 'beverage') {
        return { c: { $regex: 'Beverage|İçecek', $options: 'i' } };
    } else if (cat === 'preserve') {
        return { c: { $regex: 'Preserve|Reçel|Konserve|Kış Hazırlıkları', $options: 'i' } };
    } else {
        const safeCategory = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return { c: { $regex: '^' + safeCategory + '$', $options: 'i' } };
    }
}

async function getRecipeFromChunk(chunkId, recipeId, title = '', offset = null, length = null) {
    try {
        let key;
        let range = undefined;

        if (offset !== null && length !== null) {
            // New Pattern: Partial fetch from recipes.txt.partX
            key = `recipes.txt.part${chunkId}`;
            range = `bytes=${offset}-${offset + length - 1}`;
            console.log(`📡 R2 PARTIAL FETCH: Key=${key}, Range=${range}`);
        } else {
            // Old Pattern: Full JSON chunk
            key = `chunk_${chunkId}.json`;
            console.log(`📡 R2 FULL FETCH: Key=${key}`);
        }

        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Range: range
        });

        let data;
        try {
            const response = await s3Client.send(command);
            data = await response.Body.transformToString();
        } catch (r2err) {
            console.warn(`⚠️ R2 Fetch failed for ${key}, error: ${r2err.message}`);
            return null;
        }

        if (range) {
            // Partial text parts contain a single JSON object per recipe
            try {
                const recipe = JSON.parse(data);
                console.log(`✨ R2 MATCH FOUND via Partial Get for ${recipeId}`);
                return recipe;
            } catch (pErr) {
                console.error(`❌ Partial JSON Parse Error: ${pErr.message}`);
                return null;
            }
        }

        // Handle full JSON chunks
        const chunkData = JSON.parse(data);
        const found = chunkData.find(r => {
            const rid = (r.i || r.id || r.uid || '').toString();
            const tid = recipeId.toString();
            if (rid && rid === tid) return true;
            if (title && (chunkId === 'gastro' || chunkId === 'chef')) {
                const rTitle = (r.t || r.title || '').toString().toLowerCase().trim();
                const targetTitle = title.toLowerCase().trim();
                return rTitle === targetTitle;
            }
            return false;
        });

        return found || null;
    } catch (err) {
        console.error(`🔥 getRecipeFromChunk Error:`, err.message);
        return null;
    }
}

// ── AUTHENTICATION ENDPOINTS ──────────────────────────────

app.post('/auth/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        if (!email || !password) return res.status(400).json({ error: "Email and password required" });

        const db = mongoClient.db("foodi");
        const users = db.collection("users");

        const existing = await users.findOne({ email });
        if (existing) return res.status(400).json({ error: "User already exists" });

        const newUser = {
            email,
            password, // NOTE: In production, hash this password!
            name: name || email.split('@')[0],
            createdAt: new Date(),
            lastLogin: new Date(),
            isPremium: false
        };

        await users.insertOne(newUser);
        res.status(201).json({ message: "User registered successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const db = mongoClient.db("foodi");
        const users = db.collection("users");

        const user = await users.findOne({ email, password });
        if (!user) return res.status(401).json({ error: "Invalid credentials" });

        await users.updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } });

        res.json({
            message: "Login successful",
            token: "chef_aykut_token_" + user._id,
            user: { email: user.email, name: user.name, isPremium: user.isPremium }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/auth/social-login', async (req, res) => {
    try {
        const { email, name, provider, uid } = req.body;
        if (!email) return res.status(400).json({ error: "Email required" });

        const db = mongoClient.db("foodi");
        const users = db.collection("users");

        let user = await users.findOne({ email });

        if (!user) {
            user = {
                email,
                name: name || email.split('@')[0],
                provider: provider || 'unknown',
                providerId: uid,
                createdAt: new Date(),
                lastLogin: new Date(),
                isPremium: false
            };
            await users.insertOne(user);
        } else {
            await users.updateOne({ _id: user._id }, { $set: { lastLogin: new Date(), providerId: uid } });
        }

        res.json({
            message: "Social login successful",
            token: "chef_aykut_token_" + user._id,
            user: { email: user.email, name: user.name, isPremium: user.isPremium }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



app.get('/recipes/count', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        const category = req.query.category;
        
        let count;
        if (category) {
            count = await collection.countDocuments({ c: { $regex: '^' + category + '$', $options: 'i' } });
        } else {
            count = await collection.estimatedDocumentCount();
        }
        res.json({ count });
    } catch (err) {
        console.error(`❌ Error in /recipes/count:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/recipes/counts', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        const counts = await collection.aggregate([
            { $group: { _id: "$c", count: { $sum: 1 } } }
        ]).toArray();
        
        const result = {};
        counts.forEach(c => {
            if (c._id) result[c._id] = c.count;
        });
        res.json(result);
    } catch (err) {
        console.error(`❌ Error in /recipes/counts:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/recipes/categories/:category/subs', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        const category = req.params.category;

        let pipeline;
        if (category.toLowerCase() === 'main') {
            pipeline = [
                { $match: getCategoryQuery(category) },
                { $facet: {
                    subs: [ { $group: { _id: "$s" } } ],
                    cats: [ { $group: { _id: "$c" } } ]
                }},
                { $project: {
                    all: { $setUnion: ["$subs._id", "$cats._id"] }
                }}
            ];
            const [result] = await collection.aggregate(pipeline).toArray();
            let all = result.all.filter(s => s && s !== 'null');
            all = all.filter(s => !s.toLowerCase().includes('main dish'));
            res.json(all.sort());
        } else {
            pipeline = [
                { $match: getCategoryQuery(category) },
                { $group: { _id: "$s" } },
                { $match: { _id: { $ne: null } } },
                { $sort: { _id: 1 } },
                { $limit: 50 }
            ];
            const docs = await collection.aggregate(pipeline).toArray();
            const subs = docs.map(d => d._id).filter(s => s);
            res.json(subs);
        }
    } catch (err) {
        console.error(`❌ Server Error:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/recipes', async (req, res) => {
    console.log(`📡 Incoming /recipes request: ${JSON.stringify(req.query)}`);
    try {
        let page = parseInt(req.query.page) || 0;
        let limit = parseInt(req.query.limit) || 20;
        
        if (page < 0) page = 0;
        if (limit <= 0) limit = 20;
        if (limit > 100) limit = 100;

        const category = req.query.category;
        const subcategory = req.query.subcategory;
        const query_text = req.query.q;

        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");

        // ── Chef Pro: Doğrudan R2 chunk'tan serve et ──────────────────────────
        const cat = (category || '').toLowerCase();
        if (cat === 'chef' || cat === 'chef_pro' || cat.includes('chef')) {
            try {
                const chunkKey = 'chunk_chef.json';
                const cmd = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: chunkKey });
                let chefChunk;
                try {
                    const r2res = await s3Client.send(cmd);
                    const raw = await r2res.Body.transformToString();
                    chefChunk = JSON.parse(raw);
                } catch {
                    const fs = require('fs'), path = require('path');
                    const localPath = path.join(__dirname, chunkKey);
                    chefChunk = JSON.parse(require('fs').readFileSync(localPath, 'utf8'));
                }
                const start = page * limit;
                const slice = chefChunk.slice(start, start + limit);
                return res.json(slice.map(r => ({
                    i: r.i || r.id || r.uid || '',
                    t: r.t || r.title || '',
                    c: 'chef_pro',
                    h: 'chef',
                    p: r.p || r.img || r.image || '',
                    r: r.r || r.rating || 0,
                    s: r.s || r.subcategory || '',
                    g: r.g || r.nb_servings || '',
                    l: r.l || r.total_time || r.prep_time || '',
                    m: r.m || r.ingredients || [],
                    y: r.y || r.steps || r.instructions || [],
                    id: r.i || r.id || r.uid || '',
                    title: r.t || r.title || '',
                    category: 'chef_pro',
                    image: r.p || r.img || r.image || '',
                })));
            } catch (chefErr) {
                console.warn('⚠️ Chef chunk serve failed:', chefErr.message);
                // Fallback to MongoDB
            }
        }

        if (query_text && query_text.length > 1) {
            try {
                const searchPipeline = [
                    {
                        $search: {
                            index: "default",
                            compound: {
                                must: [{
                                    text: {
                                        query: query_text,
                                        path: ["t", "name", "title"],
                                        fuzzy: { maxEdits: 1 }
                                    }
                                }],
                                should: [
                                    {
                                        near: {
                                            path: "r",
                                            origin: 5,
                                            pivot: 2,
                                            score: { boost: 2 }
                                        }
                                    },
                                    {
                                        exists: {
                                            path: "img",
                                            score: { boost: 1.5 }
                                        }
                                    }
                                ]
                            }
                        }
                    },
                    { $skip: page * limit },
                    { $limit: limit }
                ];
                
                if (category) {
                    const catQuery = getCategoryQuery(category);
                    if (catQuery.c && catQuery.c.$regex) {
                        searchPipeline[0].$search.compound.filter = [{
                            text: {
                                query: category,
                                path: "c"
                            }
                        }];
                    } else if (catQuery.h) {
                        searchPipeline[0].$search.compound.filter = [{
                            text: {
                                query: catQuery.h,
                                path: "h"
                            }
                        }];
                    }
                }

                const searchResults = await collection.aggregate(searchPipeline).toArray();
                return res.json(searchResults.map(r => _formatRecipe(r)));
            } catch (searchErr) {
                console.warn("⚠️ Atlas Search failed, falling back to Regex:", searchErr.message);
            }
        }

        let query = {};
        if (category) {
            Object.assign(query, getCategoryQuery(category));
        }
        if (subcategory) {
            const safeSub = subcategory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.$or = [{ s: { $regex: safeSub, $options: 'i' } }, { c: { $regex: '^' + safeSub + '$', $options: 'i' } }];
        }
        if (query_text) query.t = { $regex: '^' + query_text, $options: 'i' };

        const recipes = await collection.find(query)
            .sort({ r: -1 }) 
            .skip(page * limit)
            .limit(limit)
            .toArray();
            
        res.json(recipes.map(r => _formatRecipe(r)));
    } catch (err) {
        console.error(`❌ Server Error:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

function _formatRecipe(r, details = null) {
    const cat = (r.c || r.category || '').toLowerCase();
    const fallbackImages = {
        'dessert':   'https://images.unsplash.com/photo-1551024506-0bccd828d307?q=80&w=500',
        'soup':      'https://images.unsplash.com/photo-1547592166-23ac45744acd?q=80&w=500',
        'salad':     'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?q=80&w=500',
        'beef':      'https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=500',
        'chicken':   'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?q=80&w=500',
        'breakfast': 'https://images.unsplash.com/photo-1482049016688-2d3e1b311543?q=80&w=500',
        'pasta':     'https://images.unsplash.com/photo-1555949258-eb67b1ef0ceb?q=80&w=500',
        'default':   'https://images.unsplash.com/photo-1504674900247-0877df9cc836?q=80&w=500'
    };

    // Logic: Try DB first, then R2 details
    let dbImg = r.img || r.image || (typeof r.p === 'string' && r.p.startsWith('http') ? r.p : null);
    let r2Img = details ? (details.p || details.img || details.image) : null;
    
    const isValid = (url) => url && url.length > 10 && (url.startsWith('http') || url.startsWith('https'));

    let img;
    if (isValid(dbImg)) {
        img = dbImg;
    } else if (isValid(r2Img)) {
        img = r2Img;
    } else {
        const key = Object.keys(fallbackImages).find(k => cat.includes(k)) || 'default';
        img = fallbackImages[key];
    }

    const id = r.i || r.id || r.uid || (r._id ? r._id.toString() : '');
    const chunk = r.h !== undefined ? r.h : (r.chunk !== undefined ? r.chunk : null);
    const part = r.p !== undefined && typeof r.p === 'number' ? r.p : chunk;

    return {
        i: id,
        t: r.t || r.title || r.name || 'Untitled Recipe',
        c: r.c || r.category || r.main_category || 'General',
        s: r.s || r.subcategory || r.sub_category || '',
        h: chunk,
        p: part, // Preserve numeric part index if it exists
        o: r.o,
        l: r.l,
        r: r.r || r.rating || 0,
        img: img,
        // Detailed data
        m: (details && (details.m || details.ingredients)) || r.m || r.ingredients || r.malzemeler || r.icindekiler || [],
        y: (details && (details.y || details.steps || details.instructions)) || r.y || r.steps || r.instructions || r.yapilis || [],
        g: r.g || r.nb_servings || r.servings || '',
        l_time: r.l || r.prep_time || r.total_time || '',
        // Legacy support
        id: id,
        title: r.t || r.title || r.name || 'Untitled Recipe',
        category: r.c || r.category || r.main_category || 'General',
        image: img
    };
}

app.get('/daily', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        const count = await collection.estimatedDocumentCount();
        const limit = 20;
        
        const today = new Date();
        const seedStr = `${today.getUTCFullYear()}-${today.getUTCMonth()}-${today.getUTCDate()}`;
        
        let hash = 0;
        for (let i = 0; i < seedStr.length; i++) {
            hash = ((hash << 5) - hash) + seedStr.charCodeAt(i);
            hash |= 0; 
        }
        hash = Math.abs(hash);
        
        const offset = hash % (count > limit ? count - limit : 1);
        const recipes = await collection.find({}).skip(offset).limit(limit).toArray();
            
        res.json(recipes.map(r => _formatRecipe(r)));
    } catch (err) {
        console.error(`❌ Server Error in /daily:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/recipes/:id(*)', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        const targetId = req.params.id;
        
        console.log(`🔍 API Request for ID: ${targetId}`);
        
        let query = { i: targetId };
        let recipe = await collection.findOne(query);

        if (!recipe && targetId.length === 24) {
            try {
                recipe = await collection.findOne({ _id: new ObjectId(targetId) });
            } catch (e) {}
        }

        if (!recipe) {
            console.log(`❌ Recipe not found in MongoDB: ${targetId}`);
            return res.status(404).json({ error: "Recipe not found in database", id: targetId });
        }

        console.log(`✅ Found in Mongo: ${recipe.t} (ID: ${recipe.i}, h: ${recipe.h}, _id: ${recipe._id})`);

        // Always format base data
        const base = _formatRecipe(recipe);

        if (recipe.h !== undefined && recipe.h !== null) {
            console.log(`📡 Attempting hydration for ${recipe.i || recipe._id} (h: ${recipe.h}, o: ${recipe.o}, l: ${recipe.l})`);
            const details = await getRecipeFromChunk(
                recipe.h, 
                recipe.i || recipe._id, 
                recipe.t || recipe.title,
                (recipe.o !== undefined && recipe.o !== null) ? parseInt(recipe.o) : null,
                (recipe.l !== undefined && recipe.l !== null) ? parseInt(recipe.l) : null
            );
            
            if (details) {
                console.log(`✨ Successfully hydrated from R2! m_count: ${details.m ? details.m.length : (details.ingredients ? details.ingredients.length : 0)}`);
                return res.json(_formatRecipe(recipe, details));
            } else {
                console.warn(`⚠️ Hydration failed for ${recipe.i || recipe._id}, sending basic info`);
                return res.json(_formatRecipe(recipe));
            }
        }

        return res.json(_formatRecipe(recipe));
    } catch (err) {
        console.error(`🔥 Server Error:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/ping', (req, res) => {
    res.send('pong');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await mongoClient.connect();
    console.log(`🚀 Server ready on port ${PORT}`);
    
    // Self-ping mechanism to stay awake on Cloud (Render, etc.)
    const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(() => {
        const http = require('http');
        const https = require('https');
        const client = EXTERNAL_URL.startsWith('https') ? https : http;
        
        client.get(`${EXTERNAL_URL}/ping`, (res) => {
            console.log(`📡 Self-ping successful: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error(`❌ Self-ping failed: ${err.message}`);
        });
    }, 10 * 60 * 1000); // Every 10 minutes
});
