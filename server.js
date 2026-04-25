const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// CONFIGURATION
const MONGO_URI = "mongodb+srv://aykutakcay85_db_user:ngFVD84yXt8dP0Kz@ac-g1gqdvq.6dwfgcz.mongodb.net/foodi?retryWrites=true&w=majority";
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

async function getR2Content(partIndex, offset, length) {
    const keysToTry = [
        `recipes/recipes.txt.part${partIndex}`,
        `recipes.txt.part${partIndex}`
    ];
    
    for (const key of keysToTry) {
        try {
            const range = `bytes=${offset}-${offset + length - 1}`;
            const command = new GetObjectCommand({
                Bucket: BUCKET_NAME,
                Key: key,
                Range: range,
            });
            
            const response = await s3Client.send(command);
            const body = await response.Body.transformToString();
            
            // Trim and clean potential encoding issues
            const cleanBody = body.trim();
            if (!cleanBody.startsWith('{')) {
                console.error(`⚠️ R2 Data at ${key} is not valid JSON: ${cleanBody.substring(0, 50)}...`);
                continue;
            }
            
            return JSON.parse(cleanBody);
        } catch (err) {
            if (err.name === 'NoSuchKey') {
                console.log(`ℹ️ Path not found in R2: ${key}, trying next...`);
                continue;
            }
            console.error(`❌ Error fetching from R2 (${key}):`, err.message);
        }
    }
    return null;
}

app.get('/recipes/count', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        const count = await collection.countDocuments();
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
            { $match: { c: category } },
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
            query.c = category;
        }
        if (subcategory) {
            query.s = subcategory;
        }

        if (query_text) {
            // Simple text search or Atlas Search if available
            query.$text = { $search: query_text };
        }

        const recipes = await collection.find(query)
            .skip(page * limit)
            .limit(limit)
            .toArray();

        res.json(recipes);
    } catch (err) {
        // Fallback for search if text index is missing
        if (req.query.q) {
             const db = mongoClient.db("foodi");
             const collection = db.collection("chefaykut");
             const page = parseInt(req.query.page) || 0;
             const limit = parseInt(req.query.limit) || 20;
             
             const recipes = await collection.find({ t: { $regex: req.query.q, $options: 'i' } })
                .skip(page * limit)
                .limit(limit)
                .toArray();
             return res.json(recipes);
        }
        res.status(500).json({ error: err.message });
    }
});

app.get('/recipes/:id', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        
        let query;
        try {
            query = { _id: new ObjectId(req.params.id) };
        } catch (e) {
            query = { _id: req.params.id };
        }

        const recipe = await collection.findOne(query);

        if (!recipe) {
            return res.status(404).json({ error: "Recipe not found" });
        }

        // If it has part info, fetch from R2
        if (recipe.p !== undefined && recipe.o !== undefined && recipe.l !== undefined) {
            const details = await getR2Content(recipe.p, recipe.o, recipe.l);
            if (details) {
                return res.json({ ...recipe, ...details });
            }
        }

        res.json(recipe);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await mongoClient.connect();
    console.log(`🚀 Server ready on port ${PORT}`);
});
