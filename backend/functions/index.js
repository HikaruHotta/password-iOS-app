const functions = require('firebase-functions');
const admin = require('firebase-admin');

// https://firebase.google.com/docs/functions/get-started for examples
admin.initializeApp();

function generateLobbyCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * 26)];
    }
    return code;
}

// courtesy of https://medium.com/@nitinpatel_20236/how-to-shuffle-correctly-shuffle-an-array-in-javascript-15ea3f84bfb
function shuffleArray(inputArray) {
    // copy input array:
    let array = inputArray.slice();
    for (let i = array.length - 1; i > 0; i--){
        const j = Math.floor(Math.random() * i)
        const temp = array[i]
        array[i] = array[j]
        array[j] = temp
    }
    return array;
}

async function createLobbyCodeMapping(lobbyId, timestamp) {
    let transactionError;
    return admin.database().ref('/lobbyCodeMap/').transaction(lobbyCodeMap => {
        if (!lobbyCodeMap) {
            lobbyCodeMap = {};
        }
        
        const ONE_HOUR_MS = 3600000;
        let freeCode = null;
        for (let i = 0; i < 1000; i++) {
            let currCode = generateLobbyCode();
            if (!(currCode in lobbyCodeMap) || now - lobbyCodeMap[currCode].created < ONE_HOUR_MS) {
                freeCode = currCode;
                break;
            }
        }
        if (!freeCode) {// couldn't find a lobby code, abort transaction and throw error below.
            transactionError = new functions.https.HttpsError("resource-exhausted",
                `Could not find a free lobby code in 1000 attempts.`);
            return undefined;
        }
        
        const newMapping = { lobbyId: lobbyId, created: timestamp };
        lobbyCodeMap[freeCode] = newMapping;
        lobbyCodeMap.mostRecent = freeCode;
        return lobbyCodeMap;
    }).then(result => {
        if (!result.committed) {
            throw transactionError;
        }
        const lobbyCodeMap = result.snapshot.val();
        return lobbyCodeMap.mostRecent;
    });
}

/** 
 * Try to find lobby id associated with a given lobby code.
 * Returns a promise that resolves with the id if found or rejects with an error if not.
 */
async function findLobbyIdFromCode(lobbyCode) {
    const mappingRef = admin.database().ref('/lobbyCodeMap/' + lobbyCode.toUpperCase());
    return mappingRef.once('value').then(snapshot => {
        if (!snapshot.exists()) {
            throw new functions.https.HttpsError("not-found",
                `Mapping for lobby code ${lobbyCode} not found.`);
        } else {
            let mapping = snapshot.val();
            return mapping.lobbyId;
        }
    });
}

/**
 * When a player joins a lobby we store the current lobbyId associated with their uid.
 * Checks the mapping to find a player's current lobby, returning a promise with the result.
 */
async function findLobbyIdFromUID(uid) {
    return admin.database().ref('/playerLobbyMapping/' + uid).once('value').then(snapshot => {
        if (!snapshot.exists()) {
            throw new functions.https.HttpsError("internal",
                `Could not find current lobby for user ${uid}.`)
        }
        return snapshot.val();
    });
}

function getPlayer(data) {
    const player = data.player;
    if (!player) {
        throw new functions.https.HttpsError("invalid-argument",
            `Missing player object.`);
    }
    if (!player.displayName) {
        throw new functions.https.HttpsError("invalid-argument",
            `Missing player.displayName.`);
    }
    if (player.colorNumber === undefined) {
        throw new functions.https.HttpsError("invalid-argument",
            `Missing player.colorNumber.`);
    }
    if (player.emojiNumber === undefined) {
        throw new functions.https.HttpsError("invalid-argument",
            `Missing player.emojiNumber.`);
    }
    return player;
}

function getUid(context) {
    const uid = context.auth && context.auth.uid;
    if (!uid) {
        throw new functions.https.HttpsError('unauthenticated',
            `Missing Firebase authentication information in request.`);
    }
    return uid;
}

function getWord(data) {
    const word = data.word;
    if (!word) {
        throw new functions.https.HttpsError('invalid-argument',
            `Missing word in submitWord request.`);
    }

    const alphabet = /^[a-z]+$/i;
    if (!alphabet.exec(word)) {
        throw new functions.https.HttpsError('invalid-argument',
            `Submitted word contains disallowed characters.`);
    }
    return word;
}

function getLobbyCode(data) {
    const lobbyCode = data.lobbyCode;
    if (!lobbyCode || lobbyCode.length !== 4) {
        throw new functions.https.HttpsError("invalid-argument",
            `Missing or invalid lobby code.`);
    }
    return lobbyCode;
}

/**
 * Try to add a player to the lobby with id `lobbyId`.
 * Returns promise that resolves on addition or rejects with error if lobby missing or closed.
 * Assumes player object is valid.
 */
async function addPlayerToLobby(lobbyId, player, uid) {
    const validateLobbyFn = lobby => {
        if (lobby.internal.status !== 'LOBBY') {
            return new functions.https.HttpsError("failed-precondition",
                `Lobby with id ${lobbyId} is no longer open to join.`);
        }
        return null;
    }

    const updateLobbyFn = lobby => {
        if (!lobby.public) {
            lobby.public = { players: {} };
        }
        player.score = 0;
        lobby.public.players[uid] = player;
    }
    
    const lobbyUpdate = updateLobby(lobbyId, validateLobbyFn, updateLobbyFn);
    const playerMapping = admin.database().ref('/playerLobbyMapping/' + uid).set(lobbyId);
    return Promise.all([lobbyUpdate, playerMapping]);
}

exports.createLobby = functions.https.onCall(async (data, context) => {
    const now = admin.database.ServerValue.TIMESTAMP;
    const uid = getUid(context);
    const player = getPlayer(data);
    
    const lobbyCreation = admin.database().ref('/lobbies/').push({
        internal: {
            status: "LOBBY",
            created: now,
            hostId: uid
        }
    });
    // lobbyCreation is a "ThenableReference";
    // a promise whose .key property can be accessed immediately
    const lobbyId = lobbyCreation.key;
    const lobbyCodeCreation = createLobbyCodeMapping(lobbyId, now);
    const hostAdding = lobbyCreation.then(() => {
        addPlayerToLobby(lobbyId, player, uid);
    });

    const lobbyCode = await lobbyCodeCreation;
    await hostAdding;
    return { lobbyId: lobbyId, lobbyCode: lobbyCode };
});

exports.joinLobby = functions.https.onCall(async (data, context) => {
    const uid = getUid(context);
    const player = getPlayer(data);
    const lobbyCode = getLobbyCode(data);
    const lobbyId = await findLobbyIdFromCode(lobbyCode);

    await addPlayerToLobby(lobbyId, player, uid);
    return { lobbyId: lobbyId };
});

exports.startGame = functions.https.onCall(async (data, context) => {
    const uid = getUid(context);
    const lobbyId = await findLobbyIdFromUID(uid);

    const validateLobbyFn = lobby => {
        if (lobby.internal.hostId !== uid) {
            return new functions.https.HttpsError("permission-denied",
                `You are not the host of the lobby with id ${lobbyId}.`);
        }
        if (lobby.internal.status !== 'LOBBY') {
            return new functions.https.HttpsError("failed-precondition",
                `Lobby with id ${lobbyId} already started.`);
        }
        return null;
    }
    
    const updateLobbyFn = lobby => {
        const playerIds = Object.keys(lobby.public.players);
        lobby.public.playerOrder = shuffleArray(playerIds);
        lobby.public.startWord = "password";
        const firstTurn = {
            player: lobby.public.playerOrder[0],
            submittedWord: "pizza"
        };
        lobby.public.turns = [firstTurn];

        lobby.private = {};
        for (const uid of playerIds) {
            lobby.private[uid] = { targetWords: ["quick", "brown", "fox", "jump", "dog"] };
        }

        lobby.internal.status = "SUBMISSION";
    }

    return updateLobby(lobbyId, validateLobbyFn, updateLobbyFn);
});

/**
 * WIP
 */
exports.submitWord = functions.https.onCall(async (data, context) => {
    let uid = getUid(context);
    let word = getWord(data);
    let lobbyId = await findLobbyIdFromUID(uid);

    let validateLobbyFn = lobby => {
        if (lobby.internal.status !== 'SUBMISSION') {
            return new functions.https.HttpsError("failed-precondition",
                `Lobby with id ${lobbyId} not awaiting word submission.`);
        }
        return null;
    }

    let updateLobbyFn = lobby => {
        return;
    }
    return updateLobby(lobbyId, validateLobbyFn, updateLobbyFn);
});

/**
 * Performs a transaction on a lobby object.
 * If validateLobbyFn returns an error, aborts the transaction and throws the returned error.
 * Otherwise updates the lobby object by calling updateLobbyFn.
 * @param {string} lobbyId id of lobby to update
 * @param {function} validateLobbyFn (lobby) => { return Error || null; }
 * @param {function} updateLobbyFn (lobby) => { modifyLobbyInPlace; return; }
 */
async function updateLobby(lobbyId, validateLobbyFn, updateLobbyFn) {
    const lobbyRef = admin.database().ref('/lobbies/' + lobbyId);
    let transactionError;
    return lobbyRef.transaction(lobby => {
        /* When the path /lobbies/lobbyId doesn't exist, the value of `lobby` passed into the transaction
         * callback will be null. However, we shouldn't abort the transaction when that happens, as
         * that can happen in some other transaction-edge-case scenarios. But in those situations,
         * the transaction won't complete, while when the path doesn't exist, it will.
         * So, return null in the transaction if lobby is null, then if the transaction completes and 
         * the snapshot is still null, we know that lobbyId is missing and can throw our error here. */
        if (lobby === null) {
            transactionError = new functions.https.HttpsError("not-found",
                `Lobby with id ${lobbyId} not found.`);
            return null;
        }
        transactionError = validateLobbyFn(lobby);
        if (transactionError) {
            return undefined; // abort transaction
        }
        updateLobbyFn(lobby);
        return lobby;
    }).then(result => {
        if (!result.committed || !result.snapshot.exists()) {
            throw transactionError;
        }
        return result.snapshot.val();
    });
};