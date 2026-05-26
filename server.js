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
// const limiter = rateLimit({
//     windowMs: 15 * 60 * 1000, // 15 minutes
//     max: 1000, // Limit each IP to 1000 requests per windowMs
//     message: { error: "Too many requests from this IP, please try again later." },
//     standardHeaders: true,
//     legacyHeaders: false,
// });
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
    // Allow public access to ping and images
    if (req.path === '/ping' || req.path.startsWith('/gastro_images/') || req.path.startsWith('/images/')) {
        return next();
    }
    
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
    if (cat === 'main' || cat === 'main course' || cat === 'ana yemek') {
        return { c: { $regex: 'Main Dishes|Et Yemekleri|Tavuk Yemekleri|Balık Yemekleri|Kebap|Köfte|Sebze Yemekleri|Dolma-Sarma|Bakliyat|Pilav|Makarna|Ana Yemek', $options: 'i' } };
    } else if (cat === 'appetizer' || cat === 'meze' || cat === 'baslangic') {
        return { c: { $regex: 'Appetizer|Meze|Başlangıçlar|Ara Sıcak|Zeytinyağlılar', $options: 'i' } };
    } else if (cat === 'breakfast' || cat === 'kahvalti') {
        return { c: { $regex: 'Breakfast|Kahvaltı|Kahvaltılık', $options: 'i' } };
    } else if (cat === 'soup' || cat === 'corba') {
        return { c: { $regex: 'Soup|Çorba|Çorbalar', $options: 'i' } };
    } else if (cat === 'dessert' || cat === 'tatli') {
        return { c: { $regex: 'Dessert|Tatlı|Tatlılar|Pastalar|Kurabiyeler', $options: 'i' } };
    } else if (cat === 'salad' || cat === 'salata') {
        return { c: { $regex: 'Salad|Salata|Salatalar', $options: 'i' } };
    } else if (cat === 'bread' || cat === 'bakery' || cat === 'hamur') {
        return { c: { $regex: 'Bread|Bakery|Ekmek|Hamur İşi|Börek|Poğaça|Pizzalar', $options: 'i' } };
    } else if (cat === 'sauce' || cat === 'sos') {
        return { c: { $regex: 'Sauce|Sos|Soslar', $options: 'i' } };
    } else if (cat === 'beverage' || cat === 'icecek') {
        return { c: { $regex: 'Beverage|İçecek|İçecekler|Kokteyller', $options: 'i' } };
    } else if (cat === 'preserve' || cat === 'konserve' || cat === 'recel') {
        return { c: { $regex: 'Preserve|Reçel|Konserve|Kış Hazırlıkları|Turşular', $options: 'i' } };
    } else if (cat === 'other' || cat === 'diger') {
        return { c: { $regex: 'Other|Diğer', $options: 'i' } };
    } else {
        const safeCategory = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return { c: { $regex: '^' + safeCategory + '$', $options: 'i' } };
    }
}

function normalizeTitle(str) {
    if (!str) return "";
    return str.toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Remove accents
        .replace(/[^a-z0-9]/g, " ")      // Replace special chars with space
        .replace(/\s+/g, "")            // Remove all spaces
        .replace(/\band\b/g, "")        // Remove common words that vary
        .replace(/\bve\b/g, "")
        .replace(/\bwith\b/g, "")
        .trim();
}

function _resolveImageUrl(url, category = '') {
    if (!url || typeof url !== 'string' || url === 'null') return '';
    
    const baseUrl = url.split('?v=')[0].trim();
    const proxyBaseUrl = "https://chef-aykut-backend.onrender.com";
    
    // Check if it belongs to old R2 buckets or Cloudflare Worker
    if (baseUrl.includes('pub-088807d92556487e97d1ec1df970bc86')) {
        const path = baseUrl.replace(/^https?:\/\/pub-088807d92556487e97d1ec1df970bc86\.r2\.dev/, '');
        return `${proxyBaseUrl}${path}?v=3`;
    }
    if (baseUrl.includes('pub-f31f36f3d95441bf8e622e620b1cda67')) {
        const path = baseUrl.replace(/^https?:\/\/pub-f31f36f3d95441bf8e622e620b1cda67\.r2\.dev/, '');
        return `${proxyBaseUrl}${path}?v=3`;
    }
    if (baseUrl.includes('yemek-resimler.aykutakcay85.workers.dev')) {
        const path = baseUrl.replace(/^https?:\/\/yemek-resimler\.aykutakcay85\.workers\.dev/, '');
        return `${proxyBaseUrl}${path}?v=3`;
    }
    
    // Relative filename (no protocol, no assets/)
    if (baseUrl && !baseUrl.startsWith('http') && !baseUrl.startsWith('assets/')) {
        if (category && category.toLowerCase().includes('gastro')) {
            return `${proxyBaseUrl}/gastro_images/${baseUrl}?v=3`;
        } else {
            return `${proxyBaseUrl}/images/${baseUrl}?v=3`;
        }
    }
    
    return url;
}

const chunkCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getRecipeFromChunk(chunkId, recipeId, title = '') {
    try {
        const key = `chunk_${chunkId}.json`;
        const possibleKeys = [key, `foodi/${key}`, `chunks/${key}`];
        
        let data;
        let successKey = '';

        // Check cache first
        const cacheKey = `chunk_${chunkId}`;
        const cached = chunkCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            console.log(`⚡ Chunk ${chunkId} loaded from CACHE`);
            data = cached.data;
        } else {
            for (const k of possibleKeys) {
                try {
                    const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: k });
                    const response = await s3Client.send(command);
                    data = await response.Body.transformToString();
                    if (data) {
                        successKey = k;
                        // Store in cache
                        chunkCache.set(cacheKey, { data, timestamp: Date.now() });
                        break;
                    }
                } catch (r2err) {
                    // Try next key
                }
            }
        }

        if (!data) {
            // Local Fallback
            for (const k of possibleKeys) {
                try {
                    const fs = require('fs');
                    const path = require('path');
                    const localPath = path.join(__dirname, k.includes('/') ? k.split('/').pop() : k);
                    if (fs.existsSync(localPath)) {
                        data = fs.readFileSync(localPath, 'utf8');
                        successKey = `LOCAL:${localPath}`;
                        break;
                    }
                } catch (e) {}
            }
        }

        if (!data) {
            console.warn(`❌ R2/LOCAL Fetch failed for chunk ${chunkId}. Tried: ${possibleKeys.join(', ')}`);
            return null;
        }

        console.log(`✅ Chunk ${chunkId} loaded successfully (${data.length} bytes)`);
        
        let chunkData;
        try {
            const parsed = JSON.parse(data);
            chunkData = Array.isArray(parsed) ? parsed : [parsed];
        } catch (jsonErr) {
            // JSONL Fallback
            try {
                chunkData = data.trim().split('\n').map(line => JSON.parse(line));
            } catch (jsonlErr) {
                console.error(`❌ Parse Error for ${successKey}`);
                return null;
            }
        }

        const found = chunkData.find(r => {
            const rid = (r.i || r.id || r.uid || r.url || '').toString();
            const tid = recipeId.toString();
            if (rid && rid === tid) return true;
            
            // Match by title as a fallback for ALL categories if ID fails
            if (title) {
                const rTitleNorm = normalizeTitle(r.t || r.title || r.name || '');
                const targetTitleNorm = normalizeTitle(title);
                return rTitleNorm === targetTitleNorm;
            }
            return false;
        });

        if (!found) {
            console.warn(`⚠️ Recipe ${recipeId} not found in chunk ${chunkId} by ID or Title (${title})`);
        }
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

app.get('/home/previews', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        
        const categories = [
            'gastro', 'chef', 'main', 'soup', 'sauce', 'salad', 'appetizer', 
            'dessert', 'bread', 'breakfast', 'preserve', 'beverage', 'other'
        ];

        const results = {};
        
        // Parallel fetch for 1 sample recipe per category
        const promises = categories.map(async (cat) => {
            const query = getCategoryQuery(cat);
            const recipe = await collection.findOne(query, { sort: { r: -1 } });
            if (recipe) {
                results[cat] = _formatRecipe(recipe);
            }
        });

        await Promise.all(promises);
        res.json(results);
    } catch (err) {
        console.error(`❌ Error in /home/previews:`, err.message);
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
    const tryKeys = ['img', 'image', 'imageUrl', 'image_url', 'resim', 'photo', 'pic', 'gorsel', 'resim_url', 'photo_url'];
    
    let dbImg = null;
    for (const key of tryKeys) {
        if (r[key] && typeof r[key] === 'string' && r[key].length > 5) {
            dbImg = r[key];
            break;
        }
    }
    if (!dbImg && typeof r.p === 'string' && r.p.startsWith('http')) dbImg = r.p;
    
    let r2Img = null;
    if (details) {
        for (const key of tryKeys) {
            if (details[key] && typeof details[key] === 'string' && details[key].length > 5) {
                r2Img = details[key];
                break;
            }
        }
        if (!r2Img && typeof details.p === 'string' && details.p.startsWith('http')) r2Img = details.p;
    }
    
    const isValid = (url) => {
        if (!url || typeof url !== 'string' || url.length < 10) return false;
        if (!url.startsWith('http')) return false;
        // Known domains that block hotlinking or are unreliable
        const forbiddenDomains = ['food.fnr.sndimg.com', 'sndimg.com', 'placeholder.com'];
        if (forbiddenDomains.some(domain => url.includes(domain))) return false;
        return true;
    };

    const id = r.i || r.id || r.uid || (r._id ? r._id.toString() : '');

    let img = '';
    if (isValid(r2Img)) {
        img = r2Img; // R2 details (hydration) takes priority for Gastro/Chef
    } else if (isValid(dbImg)) {
        img = dbImg;
    }

    if (!img) {
        // Final Fallback: Construct Proxy Image URL based on ID
        img = `https://chef-aykut-backend.onrender.com/images/${id}.webp`;
        console.log(`🔗 CONSTRUCTED_PROXY_IMAGE for recipe: ${r.t || r.name} -> ${img}`);
    } else {
        img = _resolveImageUrl(img, cat);
        console.log(`✅ IMAGE_RESOLVED for recipe: ${r.t || r.name} -> ${img.substring(0, 45)}...`);
    }

    const chunk = r.h !== undefined ? r.h : (r.chunk !== undefined ? r.chunk : null);
    
    // If r.p is a URL, don't overwrite it with chunk ID here; use a separate part variable
    const part = (typeof r.p === 'number') ? r.p : chunk;

    return {
        i: id,
        t: r.t || r.title || r.name || 'Untitled Recipe',
        c: r.c || r.category || r.main_category || 'General',
        s: r.s || r.subcategory || r.sub_category || '',
        h: chunk,
        p: part, 
        o: r.o,
        l: r.l,
        r: r.r || r.rating || 0,
        img: img,
        image: img,
        imageUrl: img,
        image_url: img,
        // Detailed data
        m: (details && (details.m || details.ingredients || details.malzemeler || details.icindekiler || details.components)) || r.m || r.ingredients || r.malzemeler || r.icindekiler || [],
        y: (details && (details.y || details.steps || details.instructions || details.yapilis || details.hazirlanisi || details.cooking_steps)) || r.y || r.steps || r.instructions || r.yapilis || [],
        g: r.g || r.nb_servings || r.servings || '',
        l_time: r.l || r.prep_time || r.total_time || '',
        // Legacy support
        id: id,
        title: r.t || r.title || r.name || 'Untitled Recipe',
        category: r.c || r.category || r.main_category || 'General'
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

        // HYDRATION LOGIC: Merge data from external chunks (Chef/Gastro datasets)
        let details = null;
        let effectiveH = recipe.h;

        // Force hydration for specific categories if 'h' is missing
        if (!effectiveH) {
            const category = (recipe.c || recipe.category || '').toLowerCase();
            if (category.includes('gastro') || category.includes('legacy_sauce')) {
                effectiveH = 'gastro';
            } else if (category.includes('chef') || category.includes('pro')) {
                effectiveH = 'chef';
            }
        }

        if (effectiveH !== undefined && effectiveH !== null) {
            console.log(`📡 Attempting hydration for ${recipe.i || recipe._id} (h: ${effectiveH})`);
            details = await getRecipeFromChunk(
                effectiveH, 
                recipe.i || recipe._id, 
                recipe.t || recipe.title || recipe.name
            );
            
            if (details) {
                console.log(`✅ Hydration SUCCESS for ${recipe.i || recipe._id} from chunk ${effectiveH}`);
            } else {
                console.warn(`⚠️ Hydration FAILED for ${recipe.i || recipe._id} from chunk ${effectiveH}`);
            }
        }
    
            // 🔄 FALLBACK: If primary chunk fails, try Chef and Gastro
            if (!details && recipe.h !== 'chef' && recipe.h !== 'gastro') {
                console.log(`🔍 Fallback: Trying 'chef' chunk...`);
                details = await getRecipeFromChunk('chef', recipe.i || recipe._id, recipe.t || recipe.title);
                if (!details) {
                    console.log(`🔍 Fallback: Trying 'gastro' chunk...`);
                    details = await getRecipeFromChunk('gastro', recipe.i || recipe._id, recipe.t || recipe.title);
                }
            }
            
        if (details) {
            console.log(`✨ Successfully hydrated from R2!`);
            return res.json(_formatRecipe(recipe, details));
        } else {
            console.warn(`⚠️ Hydration failed for ${recipe.i || recipe._id}, sending basic info`);
            return res.json(_formatRecipe(recipe));
        }
    } catch (err) {
        console.error(`🔥 Server Error:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.patch('/recipes/:id/image', async (req, res) => {
    try {
        const { id } = req.params;
        const { image } = req.body;

        if (!image || !image.startsWith('http')) {
            return res.status(400).json({ error: "Valid image URL required" });
        }

        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");

        const result = await collection.updateOne(
            { i: id },
            { $set: { img: image, image: image, p: image } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ error: "Recipe not found" });
        }

        console.log(`✅ Image updated for recipe ${id}`);
        res.json({ success: true, message: "Image updated successfully" });
    } catch (err) {
        console.error(`❌ Error updating image:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/gastro_images/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const key = `gastro_images/${filename}`;
        
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        
        const response = await s3Client.send(command);
        const byteArray = await response.Body.transformToByteArray();
        
        res.setHeader('Content-Type', response.ContentType || 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
        res.send(Buffer.from(byteArray));
    } catch (err) {
        console.error(`❌ Error proxying gastro image ${req.params.filename}:`, err.message);
        res.status(404).send("Image not found");
    }
});

app.get('/images/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const key = `images/${filename}`;
        
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        
        const response = await s3Client.send(command);
        const byteArray = await response.Body.transformToByteArray();
        
        res.setHeader('Content-Type', response.ContentType || 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
        res.send(Buffer.from(byteArray));
    } catch (err) {
        res.status(404).send("Image not found");
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
