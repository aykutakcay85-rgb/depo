const { MongoClient } = require('mongodb');
const MONGO_URI = 'mongodb+srv://chefaykut:669085Aykut@cluster0.5smiuj7.mongodb.net/foodi?retryWrites=true&w=majority';
const client = new MongoClient(MONGO_URI);
async function run() {
  await client.connect();
  const db = client.db('foodi');
  const collection = db.collection('chefaykut');
  const doc = await collection.findOne({ i: { $type: "number" } });
  console.log('Numeric:', doc);
  const docString = await collection.findOne({ i: { $type: "string" } });
  console.log('String:', docString ? docString.i : null);
  await client.close();
}
run();
