const { MongoClient } = require('mongodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({
    region: 'auto',
    endpoint: 'https://c1cd8dfae75fe4b50ae174f260fd5a43.r2.cloudflarestorage.com',
    credentials: {
        accessKeyId: 'a834c46f9493451741157b87ab21426d',
        secretAccessKey: '9b734ce673ce4471fe7be01c0cae8f2a1d7c772e09295d1ed228c4fa1a05e7bf'
    }
});

const client = new MongoClient('mongodb+srv://chefaykut:669085Aykut@cluster0.5smiuj7.mongodb.net/foodi?retryWrites=true&w=majority');

async function run() {
    try {
        await client.connect();
        console.log("Connected to MongoDB.");
        const db = client.db('foodi');
        const col = db.collection('chefaykut');

        console.log("Fetching chunks from R2...");
        const r_chef = await s3Client.send(new GetObjectCommand({ Bucket: 'foodi', Key: 'chunk_chef.json' }));
        const d_chef = await r_chef.Body.transformToString();
        const j_chef = JSON.parse(d_chef);

        const r_gas = await s3Client.send(new GetObjectCommand({ Bucket: 'foodi', Key: 'chunk_gastro.json' }));
        const d_gas = await r_gas.Body.transformToString();
        const j_gas = JSON.parse(d_gas);

        console.log(`Chunks loaded. Chef: ${j_chef.length}, Gastro: ${j_gas.length}`);

        const docs = await col.find({h: 'chef'}).toArray();
        console.log(`Found ${docs.length} recipes in DB with h='chef'. Checking mismatches...`);
        let updatedToGastro = 0;
        
        for(let doc of docs) {
            const inChef = j_chef.find(r => (r.i||r.id||r.uid) == doc.i || (r.t && r.t.toLowerCase() == doc.t.toLowerCase()));
            const inGas = j_gas.find(r => (r.i||r.id||r.uid) == doc.i || (r.t && r.t.toLowerCase() == doc.t.toLowerCase()));
            
            if (!inChef && inGas) {
                await col.updateOne({_id: doc._id}, {$set: {h: 'gastro'}});
                console.log(`Fixed: ${doc.t} -> h: gastro`);
                updatedToGastro++;
            }
        }
        
        console.log('Total fixed from chef to gastro: ' + updatedToGastro);
        
        // Also do the reverse check: if h: 'gastro' is actually in chunk_chef.json
        const gas_docs = await col.find({h: 'gastro'}).toArray();
        let updatedToChef = 0;
        for(let doc of gas_docs) {
            const inChef = j_chef.find(r => (r.i||r.id||r.uid) == doc.i || (r.t && r.t.toLowerCase() == doc.t.toLowerCase()));
            const inGas = j_gas.find(r => (r.i||r.id||r.uid) == doc.i || (r.t && r.t.toLowerCase() == doc.t.toLowerCase()));
            
            if (!inGas && inChef) {
                await col.updateOne({_id: doc._id}, {$set: {h: 'chef'}});
                console.log(`Fixed: ${doc.t} -> h: chef`);
                updatedToChef++;
            }
        }
        
        console.log('Total fixed from gastro to chef: ' + updatedToChef);

    } catch (e) {
        console.error(e);
    } finally {
        await client.close();
    }
}
run();
