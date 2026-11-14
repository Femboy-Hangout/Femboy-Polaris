const Tools = require("../../classes/Tools.js")
let tools = Tools.global

module.exports = {

    async run(client, serverID, importSettings={}, guilds) {

        let transferFrom = importSettings.serverID
        let foundServer = guilds.find(x => x.id == transferFrom)

        if (!foundServer) return { error: "Not in server" }
        else if (foundServer && !foundServer.owner) return { error: "Not owner in server" }
        else if (foundServer.id == serverID) return { error: "Cannot transfer from the same server" }

        let toTransfer = []
        if (importSettings.xp) toTransfer.push("users")
        if (importSettings.settings) toTransfer.push("settings")
        if (!toTransfer.length) return { error: "Invalid import options!" }

        let details = []
        let importedUsers = 0

        let transferData = await client.db.fetch(transferFrom, toTransfer)
        if (!transferData) return { error: `No Femboy Polaris data found for ${foundServer.name}`, code: "invalidImport" }

        let newData = {}

        if (importSettings.xp && transferData.users && typeof transferData.users === "object") {
            let now = Date.now();
            Object.entries(transferData.users).forEach(u => {
                const [id, val] = u
                if (!/^\d{16,20}$/.test(id) || !val || !Number.isFinite(Number(val.xp))) return
                importedUsers++
                let xpVal = { xp: tools.clamp(Math.round(Number(val.xp)), 0, 1e16 - 1) }
                if (Number.isFinite(val.cooldown) && val.cooldown > now) xpVal.cooldown = Math.round(val.cooldown)
                newData[`users.${id}`] = xpVal
            })
            details.push(`${tools.commafy(importedUsers)} user${importedUsers == 1 ? "" : "s"}`)
        }

        if (importSettings.settings && transferData.settings) {
            let currentDoc = await client.db.fetch(serverID, "settings") || await client.db.create({ _id: serverID })
            let currentSettings = currentDoc.settings
            let transferSettings = structuredClone(transferData.settings)
            transferSettings.rewards = currentSettings.rewards
            transferSettings.multipliers.roles = currentSettings.multipliers.roles
            transferSettings.multipliers.channels = currentSettings.multipliers.channels
            if (transferSettings.levelUp.channel.length > 8) transferSettings.levelUp.channel = currentSettings.levelUp.channel
            newData["settings"] = transferSettings
            details.push(`Server settings`)
        }

        return { data: newData, details }

    }
    
}