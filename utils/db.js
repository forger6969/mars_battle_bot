const { default: mongoose } = require("mongoose");

const connectDB = async () =>{
try {
    await  mongoose.connect(process.env.MONGODB_URI)
      console.log("Data Base connected");
      
} catch (err) {
    console.log("Data Base connect error");
    console.log(err);
    
}
}

module.exports = {
    connectDB
}