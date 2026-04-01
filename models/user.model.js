const { default: mongoose } = require("mongoose");

const userSchema = mongoose.Schema({
    name:{type:String},
    branch:{type:String},
    phone:{type:String},
    telegram_username:{type:String},
    telegramID:{type:String , required:true},
    status:{type:String , enum:["not_filled","filled"],default:"not_filled"}
})

const User = mongoose.model("User" , userSchema)
module.exports = User