const { MongoClient } = require('mongodb');

const MONGO_URI = "mongodb+srv://chefaykut:669085Aykut@cluster0.5smiuj7.mongodb.net/?appName=Cluster0";

async function testConnection() {
    const client = new MongoClient(MONGO_URI);
    try {
        await client.connect();
        console.log("✅ Connection successful!");
        
        const admin = client.db().admin();
        const dbs = await admin.listDatabases();
        console.log("Databases:", dbs.databases.map(db => db.name));
        
    } catch (err) {
        console.error("❌ Connection failed:", err.message);
    } finally {
        await client.close();
    }
}

testConnection();
