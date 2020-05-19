//
//  User.swift
//  password_prototype
//
//  Created by PhilipRonnie Quiambao on 5/10/20.
//  Copyright © 2020 Hikaru Hotta. All rights reserved.
//

import Foundation

struct User {
    var displayName: String
    var colorNumber: Int
    var emojiNumber: Int
    var score: Int
    
    init(dictionary: [String: Any]){
        self.displayName = dictionary["displayName"] as! String
        self.colorNumber = dictionary["colorNumber"] as! Int
        self.emojiNumber = dictionary["emojiNumber"] as! Int
        self.score = dictionary["score"] as! Int
    }
    
    init(){
        self.displayName = "Anonymous"
        self.colorNumber = 0
        self.emojiNumber = 0
        self.score = 0
    }
    
    func constructDict() -> Dictionary<String, Any> {
        let dict  = [
            "displayName" : self.displayName,
            "colorNumber" : String(colorNumber),
            "emojiNumber" : String(emojiNumber),
            "score" : String(score),
        ] as [String : Any]
        return dict
    }
}