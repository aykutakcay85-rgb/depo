const { MongoClient } = require('mongodb');
const MONGO_URI = 'mongodb+srv://chefaykut:669085Aykut@cluster0.5smiuj7.mongodb.net/foodi?retryWrites=true&w=majority';
const client = new MongoClient(MONGO_URI);
async function run() {
  await client.connect();
  const db = client.db('foodi');
  const collection = db.collection('chefaykut');
  
  // Find a recipe WITH an image to see the field name
  const withImg = await collection.findOne({ img: { $exists: true, $ne: null, $ne: '' } });
  console.log('With img field:', withImg ? { img: withImg.img, t: withImg.t } : 'None');
  
  const withImage = await collection.findOne({ image: { $exists: true, $ne: null } });
  console.log('With image field:', withImage ? { image: withImage.image } : 'None');
  
  // Check the first 3 recipes' image data
  const samples = await collection.find({}).limit(5).toArray();
  samples.forEach((s, i) => {
    console.log(`Recipe ${i}: img=${s.img}, image=${s.image}, t=${s.t}`);
  });

  await client.close();
}
run();
