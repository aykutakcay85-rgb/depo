const axios = require('axios');

async function test() {
    try {
        console.log("Testing local backend...");
        const res = await axios.get("http://localhost:3000/recipes?limit=1");
        console.log("Recipes List Sample:", res.data[0]?.t || res.data[0]?.name);
        
        if (res.data[0]) {
            const id = res.data[0]._id;
            console.log(`Testing detail for ID: ${id}`);
            const detail = await axios.get(`http://localhost:3000/recipes/${id}`);
            console.log("Detail Keys:", Object.keys(detail.data));
            console.log("Ingredients Count:", detail.data.ingredients?.length || 0);
        }
    } catch (err) {
        console.error("Test failed:", err.message);
    }
}

test();
