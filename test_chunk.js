const { MongoClient } = require('mongodb');
const MONGO_URI = 'mongodb+srv://chefaykut:669085Aykut@cluster0.5smiuj7.mongodb.net/foodi?retryWrites=true&w=majority';
const client = new MongoClient(MONGO_URI);
async function run() {
  await client.connect();
  const db = client.db('foodi');
  const collection = db.collection('chefaykut');
  const doc = await collection.findOne({ id: { $exists: true } });
  console.log('Recipe with id:', doc ? doc.id : 'None');
  const doc2 = await collection.findOne({ h: { $exists: true } });
  console.log('Recipe chunk (h):', doc2 ? doc2.h : 'None');
  await client.close();
}
run();
