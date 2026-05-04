const http = require('http');

function testEndpoint(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: path,
      headers: { 'x-api-key': 'chef-aykut-super-secret-2026-xyz' }
    };
    http.get(options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve({ status: res.statusCode, data });
        } catch(e) {
          resolve({ status: res.statusCode, raw: body.substring(0, 200) });
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  // Test /daily
  console.log('=== Testing /daily ===');
  try {
    const daily = await testEndpoint('/daily');
    console.log('Status:', daily.status);
    if (Array.isArray(daily.data)) {
      console.log('Count:', daily.data.length);
      if (daily.data.length > 0) {
        const first = daily.data[0];
        console.log('First recipe:', first.title || first.t);
        console.log('Has chunk:', first.chunk !== undefined ? first.chunk : 'MISSING ❌');
        console.log('Has image:', first.image ? '✅' : '❌');
        console.log('Has ingredients:', (first.ingredients && first.ingredients.length) ? '✅ ' + first.ingredients.length : '❌ EMPTY');
        console.log('Has steps:', (first.steps && first.steps.length) ? '✅ ' + first.steps.length : '❌ EMPTY');
      }
    } else {
      console.log('Error:', daily.data || daily.raw);
    }
  } catch(e) {
    console.error('Test failed:', e.message);
  }

  // Test /recipes/:id (specific recipe)
  console.log('\n=== Testing /recipes/:id ===');
  try {
    const detail = await testEndpoint('/recipes/3cdda31d-326f-44f7-ba86-1140cab3c8d1');
    console.log('Status:', detail.status);
    if (detail.data && detail.data.title) {
      console.log('Title:', detail.data.title);
      console.log('Has ingredients:', detail.data.ingredients?.length ? '✅ ' + detail.data.ingredients.length : '❌ EMPTY');
      console.log('Has steps:', detail.data.steps?.length ? '✅ ' + detail.data.steps.length : '❌ EMPTY');
    } else {
      console.log('Error:', detail.data || detail.raw);
    }
  } catch(e) {
    console.error('Test failed:', e.message);
  }
}

main();
