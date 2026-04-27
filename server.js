const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
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
});

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
        
        return chunkData.find(r => r.id === recipeId);
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

        const pipeline = [
            { $match: { c: { $regex: '^' + category + '$', $options: 'i' } } },
            { $group: { _id: "$s" } },
            { $match: { _id: { $ne: null } } },
            { $sort: { _id: 1 } },
            { $limit: 50 }
        ];

        const docs = await collection.aggregate(pipeline).toArray();
        const subs = docs.map(d => d._id).filter(s => s);
        res.json(subs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/recipes', async (req, res) => {
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
            // Büyük/küçük harf duyarsız arama
            query.c = { $regex: '^' + category + '$', $options: 'i' };
        }
        if (subcategory) {
            query.s = { $regex: '^' + subcategory + '$', $options: 'i' };
        }

        if (query_text) {
            // Space-saving prefix search
            query.t = { $regex: '^' + query_text, $options: 'i' };
        }

        const recipes = await collection.find(query)
            .skip(page * limit)
            .limit(limit)
            .toArray();

        // Map back to expected format if needed, or keep it short
        res.json(recipes.map(r => ({
            id: r.i,
            title: r.t,
            category: r.c,
            subcategory: r.s,
            chunk: r.h,
            _id: r._id
        })));
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

        if (recipe.h !== undefined) {
            console.log(`📡 Fetching from R2: chunk_${recipe.h}.json...`);
            const details = await getRecipeFromChunk(recipe.h, recipe.i);
            
            if (details) {
                console.log(`✨ Successfully hydrated from R2!`);
                return res.json({ 
                    id: recipe.i,
                    title: recipe.t,
                    category: recipe.c,
                    subcategory: recipe.s,
                    chunk: recipe.h,
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
        }

        console.log(`ℹ️ No chunk info, returning metadata only.`);
        res.json({
            id: recipe.i,
            title: recipe.t,
            category: recipe.c,
            subcategory: recipe.s,
            chunk: recipe.h
        });
    } catch (err) {
        console.error(`🔥 Server Error:`, err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await mongoClient.connect();
    console.log(`🚀 Server ready on port ${PORT}`);
});
