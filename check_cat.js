const { MongoClient } = require('mongodb');
const client = new MongoClient('mongodb+srv://chefaykut:669085Aykut@cluster0.5smiuj7.mongodb.net/foodi?retryWrites=true&w=majority');
async function run() {
  await client.connect();
  const db = client.db('foodi');
  const count = await db.collection('chefaykut').countDocuments({c: { $regex: '^gastro$', $options: 'i' }});
  console.log('Count for gastro:', count);
  const countChefPro = await db.collection('chefaykut').countDocuments({c: { $regex: '^chef_pro$', $options: 'i' }});
  console.log('Count for chef_pro:', countChefPro);
  const countChefOzel = await db.collection('chefaykut').countDocuments({c: { $regex: 'Chef', $options: 'i' }});
  console.log('Count for Chef Özel:', countChefOzel);
  await client.close();
}
run();
