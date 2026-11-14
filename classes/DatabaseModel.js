// for the sake of the open source project, i've moved all the database methods here. maybe it'll help if you wanna switch to a different db

const mongoose = require("mongoose")

// connect to database
const uri = process.env.MONGO_DB_URI
const dbName = process.env.MONGO_DB_NAME || "polaris"
const baseOptions = {
    dbName,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 60000
}
const dbSettings = uri ? baseOptions : Object.assign({}, baseOptions, { user: process.env.MONGO_DB_USERNAME, pass: process.env.MONGO_DB_PASSWORD })

mongoose.connect(uri || `mongodb://${process.env.MONGO_DB_IP}`, dbSettings)
.then(() => console.log(`Database connected! (${+process.uptime().toFixed(2)} secs)`))
.catch(e => { console.error('\x1b[40m\x1b[31m%s\x1b[0m', "!!! Error connecting to the database !!!"); console.error(e) })

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"])

function isSafePath(path) {
    if (typeof path !== "string" || !path.length) return false
    const keys = path.split(".")
    for (let i = 0; i < keys.length; i++) {
        if (!keys[i] || UNSAFE_KEYS.has(keys[i]) || keys[i].startsWith("$")) return false
    }
    return true
}

function setByPath(obj, path, value) {
    if (!isSafePath(path)) return
    const keys = path.split(".")
    let cur = obj
    for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]
        if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {}
        cur = cur[k]
    }
    cur[keys[keys.length - 1]] = value
}

function deleteByPath(obj, path) {
    if (!isSafePath(path)) return
    const keys = path.split(".")
    let cur = obj
    for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]
        if (cur[k] == null || typeof cur[k] !== "object") return
        cur = cur[k]
    }
    delete cur[keys[keys.length - 1]]
}

function sanitizeUpdatePayload(data) {
    if (!data || typeof data !== "object") return null
    const clean = {}
    if (data.$set && typeof data.$set === "object") {
        const cleanSet = {}
        for (const [k, v] of Object.entries(data.$set)) {
            if (isSafePath(k) && v !== undefined) cleanSet[k] = v
        }
        if (Object.keys(cleanSet).length) clean.$set = cleanSet
    }
    if (data.$unset && typeof data.$unset === "object") {
        const cleanUnset = {}
        for (const [k, v] of Object.entries(data.$unset)) {
            if (isSafePath(k)) cleanUnset[k] = v
        }
        if (Object.keys(cleanUnset).length) clean.$unset = cleanUnset
    }
    return Object.keys(clean).length ? clean : null
}

class Model {
    constructor(collectionName, schema) {
        this.collectionName = collectionName;
        this.schema = schema;
        this.model = mongoose.model(collectionName, this.schema);
        this.isServerModel = (collectionName === "servers");

        this.cache = new Map();
        this.inflight = new Map();
        this.pendingUpdates = new Map();

        this.dirtyBuffer = new Map();
        this.flushTimer = null;

        this.hydrateSettings = (rawSettings, rawInfo, id) => {
            try {
                const temp = new this.model({
                    _id: String(id || ""),
                    settings: (rawSettings && typeof rawSettings === "object") ? rawSettings : {},
                    info: (rawInfo && typeof rawInfo === "object") ? rawInfo : {}
                }).toObject();
                return { settings: temp.settings, info: temp.info };
            } catch (e) {
                const fallback = new this.model({ _id: String(id || ""), settings: {}, info: {} }).toObject();
                return { settings: fallback.settings, info: fallback.info };
            }
        };

        this.hydrateDoc = (rawDoc) => {
            if (!rawDoc) return null;
            if (!this.isServerModel) return rawDoc;
            const { settings, info } = this.hydrateSettings(rawDoc.settings, rawDoc.info, rawDoc._id);
            const rawUsers = (rawDoc.users && typeof rawDoc.users === "object" && !Array.isArray(rawDoc.users)) ? rawDoc.users : {};
            return {
                _id: String(rawDoc._id),
                users: rawUsers,
                settings,
                info,
                _version: 1
            };
        };

        this.cloneDoc = (doc) => {
            if (!doc) return null;
            if (!this.isServerModel) return doc;
            return {
                _id: doc._id,
                users: doc.users || {},
                settings: structuredClone(doc.settings),
                info: structuredClone(doc.info),
                _version: doc._version || 1
            };
        };

        // Incremental O(log N) update for a single user in the cached rankings array
        // Avoids re-iterating and re-sorting 111,548 users on every single chat message!
        this.updateSingleUserRanking = (cached, userID, oldXP, oldHidden, newXP, newHidden) => {
            const sc = cached._sortedCache;
            if (!sc) return;

            const xpArray = sc.xpArray;
            const hiddenMembers = sc.hiddenMembers;

            // 1. Remove from previous location if previously ranked (> 0 XP)
            if (oldXP > 0) {
                if (oldHidden) {
                    const hIdx = hiddenMembers.findIndex(x => x.id === userID);
                    if (hIdx !== -1) hiddenMembers.splice(hIdx, 1);
                } else {
                    // Binary search for oldXP range in descending xpArray
                    let lo = 0, hi = xpArray.length - 1, foundIdx = -1;
                    while (lo <= hi) {
                        const mid = (lo + hi) >>> 1;
                        const midXP = xpArray[mid].xp;
                        if (midXP === oldXP) {
                            // Scan nearby ties for exact userID
                            for (let i = mid; i >= 0 && xpArray[i].xp === oldXP; i--) {
                                if (xpArray[i].id === userID) { foundIdx = i; break; }
                            }
                            if (foundIdx === -1) {
                                for (let i = mid + 1; i < xpArray.length && xpArray[i].xp === oldXP; i++) {
                                    if (xpArray[i].id === userID) { foundIdx = i; break; }
                                }
                            }
                            break;
                        } else if (midXP > oldXP) {
                            lo = mid + 1;
                        } else {
                            hi = mid - 1;
                        }
                    }
                    if (foundIdx === -1) foundIdx = xpArray.findIndex(x => x.id === userID);
                    if (foundIdx !== -1) xpArray.splice(foundIdx, 1);
                }
            }

            // 2. Insert into new location if newXP > 0
            if (newXP > 0) {
                if (newHidden) {
                    let lo = 0, hi = hiddenMembers.length;
                    while (lo < hi) {
                        const mid = (lo + hi) >>> 1;
                        if (hiddenMembers[mid].xp >= newXP) lo = mid + 1;
                        else hi = mid;
                    }
                    hiddenMembers.splice(lo, 0, { id: userID, xp: newXP });
                } else {
                    let lo = 0, hi = xpArray.length;
                    while (lo < hi) {
                        const mid = (lo + hi) >>> 1;
                        if (xpArray[mid].xp >= newXP) lo = mid + 1;
                        else hi = mid;
                    }
                    xpArray.splice(lo, 0, { id: userID, xp: newXP, rank: lo + 1 });
                }
            }

            // Mark ranks as needing a fast linear rank-number pass only when getRankings is next read
            sc.ranksDirty = true;
            sc.version = cached._version;
        };

        this.applyUpdateToCache = (id, data) => {
            const cached = this.cache.get(id);
            if (!cached || !data || typeof data !== "object") return;

            cached._version = (cached._version || 1) + 1;
            let canIncrementallyRank = Boolean(cached._sortedCache && !data.$unset);
            const singleUserChanges = [];

            if (data.$unset && typeof data.$unset === "object") {
                for (const key of Object.keys(data.$unset)) {
                    if (!isSafePath(key)) continue;
                    if (key === "settings") {
                        cached.settings = this.hydrateSettings({}, cached.info, id).settings;
                    } else if (key === "users") {
                        cached.users = {};
                    } else if (key.startsWith("settings.")) {
                        deleteByPath(cached, key);
                        cached.settings = this.hydrateSettings(cached.settings, cached.info, id).settings;
                    } else {
                        deleteByPath(cached, key);
                    }
                }
            }

            if (data.$set && typeof data.$set === "object") {
                const entries = Object.entries(data.$set);
                if (entries.length > 5) canIncrementallyRank = false;

                for (const [key, val] of entries) {
                    if (!isSafePath(key)) continue;
                    if (key === "settings") {
                        cached.settings = this.hydrateSettings(val, cached.info, id).settings;
                        canIncrementallyRank = false;
                    } else if (key === "users") {
                        cached.users = (val && typeof val === "object" && !Array.isArray(val)) ? val : {};
                        canIncrementallyRank = false;
                    } else if (key.startsWith("users.")) {
                        const parts = key.split(".");
                        const uid = parts[1];
                        const prevUser = (cached.users && cached.users[uid]) || null;
                        const oldXP = (prevUser && Number.isFinite(prevUser.xp)) ? prevUser.xp : 0;
                        const oldHidden = Boolean(prevUser && prevUser.hidden);

                        if (parts.length === 2 && val && typeof val === "object") {
                            const cleanUser = { xp: Math.max(0, Math.min(1e16 - 1, Math.round(Number(val.xp) || 0))) };
                            if (Number.isFinite(val.cooldown) && val.cooldown > 0) cleanUser.cooldown = Math.round(val.cooldown);
                            if (val.hidden) cleanUser.hidden = true;
                            setByPath(cached, key, cleanUser);
                            if (canIncrementallyRank) {
                                singleUserChanges.push({ uid, oldXP, oldHidden, newXP: cleanUser.xp, newHidden: Boolean(cleanUser.hidden) });
                            }
                        } else if (parts.length === 3 && parts[2] === "xp") {
                            const safeXP = Math.max(0, Math.min(1e16 - 1, Math.round(Number(val) || 0)));
                            setByPath(cached, key, safeXP);
                            if (canIncrementallyRank) {
                                singleUserChanges.push({ uid, oldXP, oldHidden, newXP: safeXP, newHidden: oldHidden });
                            }
                        } else if (parts.length === 3 && parts[2] === "hidden") {
                            const newHidden = Boolean(val);
                            setByPath(cached, key, newHidden);
                            if (canIncrementallyRank) {
                                singleUserChanges.push({ uid, oldXP, oldHidden, newXP: oldXP, newHidden });
                            }
                        } else if (parts.length === 3 && parts[2] === "cooldown") {
                            setByPath(cached, key, val);
                            // Cooldown change does not affect leaderboard rank at all!
                            if (canIncrementallyRank && cached._sortedCache) {
                                cached._sortedCache.version = cached._version;
                            }
                        } else {
                            setByPath(cached, key, val);
                            canIncrementallyRank = false;
                        }
                    } else {
                        setByPath(cached, key, val);
                        if (cached._sortedCache && !singleUserChanges.length) {
                            cached._sortedCache.version = cached._version;
                        }
                    }
                }
            }

            if (canIncrementallyRank && cached._sortedCache) {
                for (const chg of singleUserChanges) {
                    if (chg.oldXP !== chg.newXP || chg.oldHidden !== chg.newHidden) {
                        this.updateSingleUserRanking(cached, chg.uid, chg.oldXP, chg.oldHidden, chg.newXP, chg.newHidden);
                    } else {
                        cached._sortedCache.version = cached._version;
                    }
                }
            } else {
                cached._sortedCache = null;
            }
        };

        this.loadFull = (id) => {
            const safeId = String(id || "");
            if (!safeId) return Promise.resolve(null);
            if (this.cache.has(safeId)) return Promise.resolve(this.cache.get(safeId));
            if (this.inflight.has(safeId)) return this.inflight.get(safeId);

            const promise = this.model.findById(safeId).lean().then(raw => {
                if (!raw) {
                    this.inflight.delete(safeId);
                    this.pendingUpdates.delete(safeId);
                    return null;
                }
                const doc = this.hydrateDoc(raw);
                this.cache.set(safeId, doc);
                const pending = this.pendingUpdates.get(safeId);
                if (pending && pending.length) {
                    for (const upd of pending) this.applyUpdateToCache(safeId, upd);
                }
                this.pendingUpdates.delete(safeId);
                this.inflight.delete(safeId);
                return doc;
            }).catch(err => {
                this.inflight.delete(safeId);
                this.pendingUpdates.delete(safeId);
                throw err;
            });

            this.inflight.set(safeId, promise);
            return promise;
        };

        this.preload = async (ids = []) => {
            if (!this.isServerModel || !ids.length) return;
            for (const id of ids) {
                await this.loadFull(id).catch(() => null);
            }
        };

        this.getRankings = (id, doc) => {
            const safeId = String(id || "");
            const target = this.cache.get(safeId) || doc;
            if (!target) return { xpArray: [], hiddenMembers: [] };
            if (target._sortedCache && target._sortedCache.version === target._version) {
                if (target._sortedCache.ranksDirty) {
                    const arr = target._sortedCache.xpArray;
                    for (let i = 0; i < arr.length; i++) arr[i].rank = i + 1;
                    target._sortedCache.ranksDirty = false;
                }
                return target._sortedCache;
            }
            const xpArray = [];
            const hiddenMembers = [];
            const users = target.users || {};
            for (const userID in users) {
                if (!Object.prototype.hasOwnProperty.call(users, userID)) continue;
                const u = users[userID];
                if (!u || !Number.isFinite(u.xp) || u.xp <= 0) continue;
                if (!u.hidden) xpArray.push({ id: userID, xp: u.xp });
                else hiddenMembers.push({ id: userID, xp: u.xp });
            }
            xpArray.sort((a, b) => b.xp - a.xp);
            for (let i = 0; i < xpArray.length; i++) {
                xpArray[i].rank = i + 1;
            }
            if (hiddenMembers.length) hiddenMembers.sort((a, b) => b.xp - a.xp);

            const result = { version: target._version || 1, xpArray, hiddenMembers, ranksDirty: false };
            if (this.cache.has(safeId)) this.cache.get(safeId)._sortedCache = result;
            return result;
        };

        // Fast zero-clone read path for high-frequency commands (e.g. messageCreate, /rank, /sync)
        this.fetchSettings = (id, userID) => {
            const safeId = String(id || "");
            if (!safeId) return Promise.resolve(null);
            if (this.cache.has(safeId)) {
                const doc = this.cache.get(safeId);
                return Promise.resolve({
                    _id: doc._id,
                    settings: doc.settings,
                    info: doc.info,
                    users: doc.users || {}
                });
            }
            const filter = userID ? ["settings", `users.${userID}`] : ["settings"];
            this.loadFull(safeId).catch(() => null);
            return this.model.findById(safeId, filter).maxTimeMS(10000).lean().then(raw => this.hydrateDoc(raw));
        };

        this.fetch = (id, filter, options) => {
            if (id == null || typeof id !== "string") return Promise.resolve(null);
            if (Array.isArray(filter)) filter = filter.filter(Boolean);
            if (!this.isServerModel) return this.model.findById(id, filter, options).maxTimeMS(5000).lean();

            if (this.cache.has(id)) {
                return Promise.resolve(this.cloneDoc(this.cache.get(id)));
            }

            // If a lightweight projection was requested (e.g. settings + single user) and full doc isn't cached yet,
            // return the projected query quickly while warming the full cache in the background.
            if (filter) {
                this.loadFull(id).catch(() => null);
                return this.model.findById(id, filter, options).maxTimeMS(10000).lean().then(raw => this.hydrateDoc(raw));
            }

            return this.loadFull(id).then(doc => this.cloneDoc(doc));
        };

        // Flush any buffered high-frequency XP updates to MongoDB Atlas in a single atomic updateOne per server
        this.flushDirty = async () => {
            if (!this.dirtyBuffer.size) return;
            const entries = Array.from(this.dirtyBuffer.entries());
            this.dirtyBuffer.clear();
            await Promise.all(entries.map(([guildId, setMap]) => {
                const $set = Object.fromEntries(setMap);
                return this.model.updateOne({ _id: guildId }, { $set }).catch(e => console.warn("DB flush error:", e.message));
            }));
        };

        // Queue a high-frequency XP gain update: updates RAM cache & rankings immediately (0ms)
        // and coalesces MongoDB Atlas writes every 2.5 seconds (100% identical schema in MongoDB!)
        this.queueUserUpdate = (id, userID, userData) => {
            const safeId = String(id || "");
            const safeUser = String(userID || "");
            if (!safeId || !/^\d{10,30}$/.test(safeUser) || !userData || typeof userData !== "object") return;

            const cleanUser = { xp: Math.max(0, Math.min(1e16 - 1, Math.round(Number(userData.xp) || 0))) };
            if (Number.isFinite(userData.cooldown) && userData.cooldown > 0) cleanUser.cooldown = Math.round(userData.cooldown);
            if (userData.hidden) cleanUser.hidden = true;

            const payload = { $set: { [`users.${safeUser}`]: cleanUser } };
            if (this.cache.has(safeId)) {
                this.applyUpdateToCache(safeId, payload);
            } else if (this.inflight.has(safeId)) {
                if (!this.pendingUpdates.has(safeId)) this.pendingUpdates.set(safeId, []);
                this.pendingUpdates.get(safeId).push(payload);
            }

            if (!this.dirtyBuffer.has(safeId)) this.dirtyBuffer.set(safeId, new Map());
            this.dirtyBuffer.get(safeId).set(`users.${safeUser}`, cleanUser);

            if (!this.flushTimer) {
                this.flushTimer = setTimeout(() => {
                    this.flushTimer = null;
                    this.flushDirty();
                }, 2500);
                if (this.flushTimer.unref) this.flushTimer.unref();
            }
        };

        if (this.isServerModel) {
            const flushOnExit = () => { this.flushDirty().catch(() => {}); };
            process.once("SIGTERM", flushOnExit);
            process.once("SIGINT", flushOnExit);
            process.once("beforeExit", flushOnExit);
        }

        this.update = (id, data, options) => {
            const safeId = String(id || "");
            const sanitized = this.isServerModel ? sanitizeUpdatePayload(data) : data;
            if (this.isServerModel && sanitized) {
                if (this.cache.has(safeId)) {
                    this.applyUpdateToCache(safeId, sanitized);
                } else if (this.inflight.has(safeId)) {
                    if (!this.pendingUpdates.has(safeId)) this.pendingUpdates.set(safeId, []);
                    this.pendingUpdates.get(safeId).push(sanitized);
                }
                // Keep dirtyBuffer coherent if an explicit update modifies a buffered path
                if (this.dirtyBuffer.has(safeId)) {
                    const buf = this.dirtyBuffer.get(safeId);
                    if (sanitized.$unset) {
                        for (const k of Object.keys(sanitized.$unset)) {
                            if (k === "users") buf.clear();
                            else buf.delete(k);
                        }
                    }
                    if (sanitized.$set) {
                        for (const k of Object.keys(sanitized.$set)) {
                            if (k === "users") buf.clear();
                            else buf.delete(k);
                        }
                    }
                }
            }
            return this.model.updateOne({ _id: safeId }, sanitized || data, options);
        };

        this.create = (data, options) => {
            return this.model.create(data, options).then(created => {
                if (this.isServerModel && created) {
                    const raw = created.toObject ? created.toObject() : created;
                    const doc = this.hydrateDoc(raw);
                    this.cache.set(doc._id, doc);
                    return this.cloneDoc(doc);
                }
                return created;
            });
        };

        this.find = (query, filter, options) => {
            if (Array.isArray(filter)) filter = filter.filter(Boolean);
            if (this.isServerModel && query && query._id && Array.isArray(query._id.$in)) {
                const requestedIds = query._id.$in.map(x => String(x));
                const cachedResults = [];
                const missingIds = [];
                const settingsOnly = (filter === "settings");
                for (const gid of requestedIds) {
                    if (this.cache.has(gid)) {
                        const doc = this.cache.get(gid);
                        cachedResults.push(settingsOnly
                            ? { _id: doc._id, settings: structuredClone(doc.settings), info: structuredClone(doc.info) }
                            : this.cloneDoc(doc)
                        );
                    } else {
                        missingIds.push(gid);
                    }
                }
                if (!missingIds.length) return Promise.resolve(cachedResults);
                return this.model.find({ _id: { $in: missingIds } }, filter, options).maxTimeMS(5000).lean()
                    .then(list => {
                        const fetched = Array.isArray(list) ? list.map(raw => this.hydrateDoc(raw)).filter(Boolean) : [];
                        return cachedResults.concat(fetched);
                    })
                    .catch(() => cachedResults);
            }
            return this.model.find(query, filter, options).maxTimeMS(10000).lean().then(list => {
                if (!this.isServerModel || !Array.isArray(list)) return list;
                return list.map(raw => {
                    if (raw && this.cache.has(raw._id)) return this.cloneDoc(this.cache.get(raw._id));
                    return this.hydrateDoc(raw);
                });
            });
        };

        this.delete = (query, options) => {
            if (this.isServerModel && query && typeof query._id === "string") {
                this.cache.delete(query._id);
                this.dirtyBuffer.delete(query._id);
            }
            return this.model.deleteMany(query, options);
        };
    }
}

module.exports = Model;