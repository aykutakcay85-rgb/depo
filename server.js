const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require("@smithy/node-http-handler");
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// CONFIGURATION
const MONGO_URI = "mongodb+srv://chefaykut:669085Aykut@cluster0.5smiuj7.mongodb.net/foodi?retryWrites=true&w=majority";
const R2_ENDPOINT = "https://c1cd8dfae75fe4b50ae174f260fd5a43.r2.cloudflarestorage.com";
const R2_ACCESS_KEY = "a834c46f9493451741157b87ab21426d";
const R2_SECRET_KEY = "9b734ce673ce4471fe7be01c0cae8f2a1d7c772e09295d1ed228c4fa1a05e7bf";
const BUCKET_NAME = "foodi";

// CLIENTS
const mongoClient = new MongoClient(MONGO_URI);
const s3Client = new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    credentials: {
        accessKeyId: R2_ACCESS_KEY,
        secretAccessKey: R2_SECRET_KEY,
    },
    requestHandler: new NodeHttpHandler({
        connectionTimeout: 10000,
        socketTimeout: 10000,
        maxSockets: 500, // Devasa artış
    }),
});

// SECURITY: API KEY
const APP_API_KEY = "chef-aykut-super-secret-2026-xyz"; // Bunu kimse bilmemeli

function authenticate(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (req.path === '/ping') return next(); // Ping serbest
    
    if (apiKey && apiKey === APP_API_KEY) {
        next();
    } else {
        console.warn(`🚨 Unauthorized access attempt from IP: ${req.ip}`);
        res.status(401).json({ error: "Unauthorized access. Invalid API Key." });
    }
}

app.use(authenticate);

function getCategoryQuery(category) {
    const cat = category.toLowerCase();
    if (cat === 'all') return {};
    if (cat === 'gastro') return { c: 'gastro' };
    if (cat === 'chef_pro') return { c: 'chef_pro' };
    
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

async function getRecipeFromChunk(chunkId, recipeId) {
    try {
        const key = `chunk_${chunkId}.json`;
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
        });
        
        const response = await s3Client.send(command);
        const body = await response.Body.transformToString();
        const chunkData = JSON.parse(body);
        
        return chunkData.find(r => (r.i === recipeId || r.id === recipeId));
    } catch (err) {
        console.error(`❌ Error fetching chunk ${chunkId} from R2:`, err.message);
        if (err.name === 'SyntaxError') {
            console.error(`❌ JSON Parse Error in chunk ${chunkId}. File might be corrupt.`);
        }
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
            // Belirli bir kategori isteniyorsa
            count = await collection.countDocuments({ c: { $regex: '^' + category + '$', $options: 'i' } });
        } else {
            // Toplam sayı isteniyorsa (Hızlı)
            count = await collection.estimatedDocumentCount();
        }
        res.json({ count });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

app.get('/recipes/categories/:category/subs', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        const category = req.params.category;

        let pipeline;
        if (category.toLowerCase() === 'main') {
            // Ana yemekler için özel durum: Gerçek alt kategoriler + İlgili ana kategoriler
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
            // 'Main Dishes' kendisini listeden çıkaralım ki sonsuz döngü olmasın
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
        res.status(500).json({ error: err.message });
    }
});

app.get('/recipes', async (req, res) => {
    console.log(`📡 Incoming /recipes request: ${JSON.stringify(req.query)}`);
    try {
        const page = parseInt(req.query.page) || 0;
        const limit = parseInt(req.query.limit) || 20;
        const category = req.query.category;
        const subcategory = req.query.subcategory;
        const query_text = req.query.q;

        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");

        let query = {};
        if (category) {
            query.c = getCategoryQuery(category);
        }
        if (subcategory) {
            const safeSub = subcategory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.$or = [
                { s: { $regex: safeSub, $options: 'i' } },
                { c: { $regex: '^' + safeSub + '$', $options: 'i' } }
            ];
        }
        
        console.log(`🔍 Query: cat=${category}, sub=${subcategory}, text=${query_text} -> Mongo Query:`, JSON.stringify(query));


        if (query_text) {
            // Space-saving prefix search
            query.t = { $regex: '^' + query_text, $options: 'i' };
        }

        const recipes = await collection.find(query)
            .skip(page * limit)
            .limit(limit)
            .toArray();
            
        console.log(`📦 Found ${recipes.length} recipes in Mongo`);


        // Fallback image map (kategoriye göre)
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

        // Hydration removed for list view to prevent timeout
        res.json(recipes.map(r => {
            const cat = (r.c || r.category || '').toLowerCase();
            let img = r.img || r.image;
            if (!img || img.length < 5) {
                // Kategoriye göre fallback
                const key = Object.keys(fallbackImages).find(k => cat.includes(k)) || 'default';
                img = fallbackImages[key];
            }
                        return {
                i: r.i || r.id || r.uid || r._id.toString(),
                t: r.t || r.title || r.name,
                c: r.c || r.category || r.main_category,
                s: r.s || r.subcategory || r.sub_category,
                h: r.h !== undefined ? r.h : (r.chunk !== undefined ? r.chunk : null),
                r: r.r || r.rating || 0,
                p: img,
                // Fallbacks for older client versions
                id: r.i || r.id || r.uid || r._id.toString(),
                title: r.t || r.title || r.name,
                category: r.c || r.category || r.main_category,
                image: img,
                _id: r._id
            };
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/daily', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        
        // Count documents
        const count = await collection.estimatedDocumentCount();
        const limit = 20;
        
        // Generate daily seed based on UTC Date
        const today = new Date();
        const seedStr = `${today.getUTCFullYear()}-${today.getUTCMonth()}-${today.getUTCDate()}`;
        
        let hash = 0;
        for (let i = 0; i < seedStr.length; i++) {
            hash = ((hash << 5) - hash) + seedStr.charCodeAt(i);
            hash |= 0; 
        }
        hash = Math.abs(hash);
        
        // Calculate offset (seeded pseudo-random)
        const offset = hash % (count > limit ? count - limit : 1);
        
        // Tüm tarifleri çek (img filtresi KALDIRILDI - çoğu kayıtta img yok)
        const recipes = await collection.find({})
            .skip(offset)
            .limit(limit)
            .toArray();
        
        // Fallback image map (kategoriye göre)
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
            
        res.json(recipes.map(r => {
            const cat = (r.c || r.category || '').toLowerCase();
            let img = r.img || r.image;
            if (!img || img.length < 5) {
                const key = Object.keys(fallbackImages).find(k => cat.includes(k)) || 'default';
                img = fallbackImages[key];
            }
                        return {
                i: r.i || r.id || r.uid || r._id.toString(),
                t: r.t || r.title || r.name,
                c: r.c || r.category || r.main_category,
                s: r.s || r.subcategory || r.sub_category,
                h: r.h !== undefined ? r.h : (r.chunk !== undefined ? r.chunk : null),
                r: r.r || r.rating || 0,
                p: img,
                // Fallbacks for older client versions
                id: r.i || r.id || r.uid || r._id.toString(),
                title: r.t || r.title || r.name,
                category: r.c || r.category || r.main_category,
                image: img,
                _id: r._id
            };
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/recipes/:id(*)', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        const targetId = req.params.id;
        
        console.log(`🔍 API Request for ID: ${targetId}`);
        
        // Try searching by custom ID field 'i' first, then by MongoDB's internal _id
        let query = { i: targetId };
        let recipe = await collection.findOne(query);

        if (!recipe && targetId.length === 24) {
            try {
                recipe = await collection.findOne({ _id: new ObjectId(targetId) });
                if (recipe) console.log(`✅ Found by ObjectId: ${targetId}`);
            } catch (e) {
                console.log(`⚠️ Invalid ObjectId format: ${targetId}`);
            }
        }

        if (!recipe) {
            console.log(`❌ Recipe not found in MongoDB: ${targetId}`);
            return res.status(404).json({ error: "Recipe not found in database", id: targetId });
        }

        console.log(`✅ Found in Mongo. Chunk: ${recipe.h}, Title: ${recipe.t}`);

        if (recipe.h !== undefined && recipe.h !== null) {
            console.log(`📡 Fetching from R2: chunk_${recipe.h}.json...`);
            const details = await getRecipeFromChunk(recipe.h, recipe.i);
            
            if (details) {
                console.log(`✨ Successfully hydrated from R2!`);
                return res.json({ 
                    id: recipe.i || recipe.id || recipe.uid,
                    i: recipe.i || recipe.id || recipe.uid,
                    title: recipe.t || recipe.title || recipe.name,
                    t: recipe.t || recipe.title || recipe.name,
                    category: recipe.c || recipe.category,
                    c: recipe.c || recipe.category,
                    subcategory: recipe.s || recipe.subcategory,
                    s: recipe.s || recipe.subcategory,
                    chunk: recipe.h,
                    h: recipe.h,
                    ...details 
                });
            } else {
                console.log(`⚠️ Detail NOT found in chunk file for ID: ${recipe.i}`);
                return res.status(404).json({ 
                    error: "Detail not found in chunk file", 
                    chunk: recipe.h,
                    id: recipe.i 
                });
            }
        } else {
            console.log(`📦 Returning embedded data for: ${recipe.t}`);
            return res.json({
                id: recipe.i,
                title: recipe.t,
                category: recipe.c,
                subcategory: recipe.s,
                chunk: null,
                ingredients: recipe.ingredients || [],
                steps: recipe.steps || [],
                tips: recipe.tips || [],
                suggestions: recipe.suggestions || [],
                nutrition: recipe.nutrition || {}
            });
        }
    } catch (err) {
        console.error(`🔥 Server Error:`, err);
        res.status(500).json({ error: err.message });
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
