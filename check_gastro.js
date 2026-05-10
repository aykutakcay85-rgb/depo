const { MongoClient } = require('mongodb');
const client = new MongoClient('mongodb+srv://chefaykut:669085Aykut@cluster0.5smiuj7.mongodb.net/foodi?retryWrites=true&w=majority');
async function run() {
  await client.connect();
  const db = client.db('foodi');
  const d1 = await db.collection('chefaykut').findOne({c: { $regex: '^gastro$', $options: 'i' }});
  console.log('Gastro matched document:', d1);
  await client.close();
}
run();
