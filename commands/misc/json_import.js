const Tools = require("../../classes/Tools.js")
let tools = Tools.global

module.exports = {

    async run(client, serverID, importSettings={}, jsonData) {

        let details = []
        let newData = {}
        let importedUsers = 0

        if (!jsonData || typeof jsonData !== "object" || Array.isArray(jsonData)) {
            return { error: "No valid JSON object provided!" }
        }

        if (jsonData.xp) jsonData.users = jsonData.xp  // in case someone messes this up
        if (!jsonData.users && !jsonData.settings && jsonData instanceof Object && !Array.isArray(jsonData)) jsonData = { users: jsonData }   // if no keys provided, assume it's just XP

        if (jsonData.users && typeof jsonData.users === "object" && !Array.isArray(jsonData.users) && importSettings.xp) {
            let userEntries = Object.entries(jsonData.users)
            if (!importSettings.isDev && userEntries.length > 2000) return { error: "You can only import up to 2000 users, unless you're a developer of the bot! Remove any invalid IDs, or users with low XP." }

            userEntries.forEach(u => {
                const [id, x] = u
                if (typeof id === "string" && /^\d{16,20}$/.test(id) && x && typeof x === "object") {
                    const numXP = Number(x.xp)
                    if (!Number.isFinite(numXP) || numXP < 0) return

                    importedUsers++

                    // validate and clamp values so MongoDB Atlas never receives NaN/Infinity/corrupt fields
                    let obj = { xp: tools.clamp(Math.round(numXP), 0, 1e16 - 1) }
                    const numCooldown = Number(x.cooldown)
                    if (Number.isFinite(numCooldown) && numCooldown > 0) obj.cooldown = Math.round(numCooldown)
                    if (x.hidden === true) obj.hidden = true

                    newData[`users.${id}`] = obj
                }
            })
            if (importedUsers > 0) details.push(`${tools.commafy(importedUsers)} user${importedUsers == 1 ? "" : "s"}`)
        }

        if (jsonData.settings && typeof jsonData.settings === "object" && !Array.isArray(jsonData.settings) && importSettings.settings) {
            newData["settings"] = jsonData.settings
            details.push(`Server settings`)
        }

        if (!details.length) return { error: `No JSON data found! Syntax is { users: {...}, settings: {...} }` }

        return { data: newData, details }

    }
    
}