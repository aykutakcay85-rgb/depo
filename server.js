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
    max: 100, // Limit each IP to 100 requests per windowMs
    message: { error: "Too many requests from this IP, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

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
    if (cat === 'chef_pro') return { c: { $regex: '^chef_pro$', $options: 'i' } };
    
    // Özel durumlar ve eşlemeler
    if (cat.includes('chef')) {
        return { $regex: 'Chef', $options: 'i' };
    } else if (cat === 'main') {
        return { $regex: 'Main Dishes|Et Yemekleri|Tavuk Yemekleri|Balık Yemekleri|Kebap|Köfte|Sebze Yemekleri|Dolma-Sarma|Bakliyat|Pilav|Makarna', $options: 'i' };
    } else if (cat === 'appetizer') {
        return { $regex: 'Appetizer', $options: 'i' };
    } else if (cat === 'breakfast') {
        return { $regex: 'Breakfast', $options: 'i' };
    } else if (cat === 'sauce') {
        return { $regex: 'Sauce|Sos', $options: 'i' };
    } else if (cat === 'beverage') {
        return { $regex: 'Beverage|İçecek', $options: 'i' };
    } else if (cat === 'preserve') {
        return { $regex: 'Preserve|Reçel|Konserve|Kış Hazırlıkları', $options: 'i' };
    } else {
        const safeCategory = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return { $regex: '^' + safeCategory + '$', $options: 'i' };
    }
}

async function getRecipeFromChunk(chunkId, recipeId, title = '') {
    try {
        const key = `chunk_${chunkId}.json`;
        console.log(`📡 R2 FETCH: Bucket=${BUCKET_NAME}, Key=${key}, Recipe=${recipeId}`);
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
        });

        const response = await s3Client.send(command);
        const data = await response.Body.transformToString();
        const chunkData = JSON.parse(data);
        console.log(`✅ Chunk loaded: ${key} (${chunkData.length} recipes)`);

        const found = chunkData.find(r => {
            const rid = (r.i || r.id || r.uid || '').toString();
            const tid = recipeId.toString();
            if (rid && rid === tid) return true;
            
            // Fallback: Match by title if it's a special category chunk
            if (title && (chunkId === 'gastro' || chunkId === 'chef')) {
                const rTitle = (r.t || r.title || '').toString().toLowerCase().trim();
                const targetTitle = title.toLowerCase().trim();
                return rTitle === targetTitle;
            }
            return false;
        });

        if (found) {
            console.log(`✨ R2 MATCH FOUND for ${recipeId}`);
            return found;
        } else {
            console.warn(`⚠️ R2 MISMATCH: Recipe ${recipeId} NOT found in ${key}`);
            return null;
        }
    } catch (err) {
        return null;
    }
}



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
                { $match: { c: getCategoryQuery(category) } },
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
                { $match: { c: getCategoryQuery(category) } },
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
                    searchPipeline[0].$search.compound.filter = [{
                        text: {
                            query: category,
                            path: "c"
                        }
                    }];
                }

                const searchResults = await collection.aggregate(searchPipeline).toArray();
                return res.json(searchResults.map(r => _formatRecipe(r)));
            } catch (searchErr) {
                console.warn("⚠️ Atlas Search failed, falling back to Regex:", searchErr.message);
            }
        }

        let query = {};
        if (category) query.c = getCategoryQuery(category);
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

    // Priority: details.p (from R2) -> r.img -> r.image -> r.p (from DB)
    let img = (details && details.p) || r.img || r.image || r.p;
    
    // Check if the image is a valid URL (not a dummy string or too short)
    const isValidImg = img && img.length > 10 && (img.startsWith('http') || img.startsWith('https'));
    
    if (!isValidImg) {
        const key = Object.keys(fallbackImages).find(k => cat.includes(k)) || 'default';
        img = fallbackImages[key];
    }

    const id = r.i || r.id || r.uid || (r._id ? r._id.toString() : '');
    return {
        i: id,
        t: r.t || r.title || r.name || 'Untitled Recipe',
        c: r.c || r.category || r.main_category || 'General',
        s: r.s || r.subcategory || r.sub_category || '',
        h: r.h !== undefined ? r.h : (r.chunk !== undefined ? r.chunk : null),
        r: r.r || r.rating || 0,
        p: img,
        // Detailed data: prioritize details (from chunk) over r (from DB)
        m: (details && details.m) || r.m || r.ingredients || [],
        y: (details && details.y) || r.y || r.steps || r.instructions || [],
        g: r.g || r.nb_servings || r.servings || '',
        l: r.l || r.prep_time || r.total_time || '',
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
            console.log(`📡 Attempting hydration from chunk ${recipe.h} for ${recipe.i}`);
            const details = await getRecipeFromChunk(recipe.h, recipe.i || recipe._id, recipe.t || recipe.title);
            
            if (details) {
                console.log(`✨ Successfully hydrated from R2! m_count: ${details.m ? details.m.length : 0}, y_count: ${details.y ? details.y.length : 0}`);
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
