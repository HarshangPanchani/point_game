import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, onValue, get, update, onDisconnect, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

window.firebaseSDK = { initializeApp, getDatabase, ref, set, onValue, get, update, onDisconnect, serverTimestamp };

const firebaseConfig = {
    apiKey: "AIzaSyAZ7-gmZfu6nfRvY-4hqdqQ86lGE405RQU",
    authDomain: "pointgame-281d5.firebaseapp.com",
    databaseURL: "https://pointgame-281d5-default-rtdb.asia-southeast1.firebasedatabase.app/",
    projectId: "pointgame-281d5",
    storageBucket: "pointgame-281d5.appspot.com",
    messagingSenderId: "1006005693168",
    appId: "1:1006005693168:web:e26847ed3f4371146bf035"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

class PointGame {
    constructor() {
        // Persistent user ID ensures same player identity across reloads
        if (!localStorage.getItem('pointGamePlayerId')) {
            localStorage.setItem('pointGamePlayerId', 'player_' + Date.now() + Math.random().toString(36).substr(2, 5));
        }
        this.myId = localStorage.getItem('pointGamePlayerId');

        // Unique session instance per tab/window to avoid accidental same-ID collisions
        if (!sessionStorage.getItem('pointGameSessionId')) {
            sessionStorage.setItem('pointGameSessionId', 'session_' + Date.now() + Math.random().toString(36).substr(2, 8));
        }
        this.sessionId = sessionStorage.getItem('pointGameSessionId');

        this.myName = '';
        this.isHost = false;
        this.gameCode = null;
        this.gameRef = null;
        this.selectedCardIndices = [];
        this.lastGameState = {}; // For detecting changes to animate
        this.hostMigrationRef = null;
        this.hostAutoMigrationTimer = null;
        this.hostHeartbeatInterval = null;
        this.hostOfflineTimeoutMs = 12000; // 12 seconds timeout for host failover (End User optimization)
    }

    // --- LOBBY & CONNECTION ---

    showScreen(id) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active-screen'));
        document.getElementById(id).classList.add('active-screen');
    }

    showToast(msg) {
        const t = document.getElementById('toast');
        t.innerText = msg;
        t.style.opacity = 1;
        setTimeout(() => t.style.opacity = 0, 2500);
    }

    showJoinInput() { document.getElementById('join-container').style.display = 'block'; }

    copyLobbyLink() {
        const url = window.location.href.split('?')[0] + '?gameCode=' + this.gameCode;
        navigator.clipboard.writeText(url).then(() => this.showToast('Game link copied!'));
    }

    async createLobby() {
        this.myName = document.getElementById('username').value.trim();
        if (!this.myName) return this.showToast("Please enter your name.");

        this.isHost = true;

        // --- FIX FOR BUG #10: Validate lobby code doesn't exist ---
        let attempts = 0;
        let codeExists = true;
        while (codeExists && attempts < 5) {
            this.gameCode = Math.random().toString(36).substring(2, 8).toUpperCase();
            this.gameRef = ref(db, 'games/' + this.gameCode);
            const snapshot = await get(this.gameRef);
            codeExists = snapshot.exists();
            attempts++;
        }

        if (codeExists) {
            return this.showToast("Failed to create unique lobby. Please try again.");
        }

        const initialGameState = {
            hostId: this.myId,
            status: 'lobby',
            settings: {
                latePenalty: 10,
                hostOfflineTimeoutSeconds: 50
            },
            players: { [this.myId]: { name: this.myName, online: true } },
            currentRound: 0,
        };

        await set(this.gameRef, initialGameState);
        this.listenForGameUpdates();
    }

    async joinLobby() {
        this.myName = document.getElementById('username').value.trim();
        const code = document.getElementById('room-code-input').value.trim().toUpperCase();
        if (!this.myName || !code) return this.showToast("Enter name and code.");

        try {
            this.gameCode = code;
            this.gameRef = ref(db, 'games/' + this.gameCode);

            const snapshot = await get(this.gameRef);
            if (!snapshot.exists()) return this.showToast("Game code not found.");

            const gameData = snapshot.val();
            const updates = {
                [`players/${this.myId}/name`]: this.myName,
                [`players/${this.myId}/online`]: true
            };

            if (gameData.status !== 'lobby') {
                // --- THIS IS THE CRITICAL ADDITION ---
                // Mark the player as inactive for the current round.
                updates[`players/${this.myId}/activeInRound`] = false;

                const roundsToPenalize = gameData.currentRound > 0 ? gameData.currentRound : 0;
                for (let i = 1; i <= roundsToPenalize; i++) {
                    updates[`scores/${i}/${this.myId}`] = gameData.settings.latePenalty;
                }
            }

            await update(this.gameRef, updates);
            this.listenForGameUpdates();
        } catch (error) {
            console.error('Join lobby error:', error);
            this.showToast("Network error. Please check your connection.");
        }
    }

    listenForGameUpdates() {
        const playerBaseRef = ref(db, `games/${this.gameCode}/players/${this.myId}`);

        // Keep player presence consistent for UI/monitoring
        update(playerBaseRef, {
            online: true,
            sessionId: this.sessionId,
            lastSeen: serverTimestamp()
        });

        onDisconnect(playerBaseRef).set({
            name: this.myName,
            online: false,
            sessionId: this.sessionId,
            lastSeen: serverTimestamp()
        });

        // --- START: HOST MIGRATION LOGIC ---
        const hostStatusRef = ref(db, `games/${this.gameCode}/hostStatus`);

        if (this.isHost) {
            // Mark host live in state so we can detect lost host over the timeout window.
            set(hostStatusRef, {
                hostId: this.myId,
                online: true,
                lastSeen: serverTimestamp(),
                migrating: false
            });

            // Setup onDisconnect for host status as fallback
            onDisconnect(hostStatusRef).set({
                hostId: this.myId,
                online: false,
                lastSeen: serverTimestamp(),
                migrating: true
            });

            // Keep host heartbeat updating status while running.
            if (this.hostHeartbeatInterval) clearInterval(this.hostHeartbeatInterval);
            this.hostHeartbeatInterval = setInterval(() => {
                set(hostStatusRef, {
                    hostId: this.myId,
                    online: true,
                    lastSeen: serverTimestamp(),
                    migrating: false
                });
            }, 4000); // Heartbeat every 4 seconds for faster detection
        }

        // --- END: HOST MIGRATION LOGIC ---

        // --- NEW: PROACTIVE HOST MONITORING (End User Optimization) ---
        if (this.hostAutoMigrationTimer) clearInterval(this.hostAutoMigrationTimer);
        this.hostAutoMigrationTimer = setInterval(() => {
            if (this.isHost) return; // I am host, no need to monitor

            get(hostStatusRef).then(snapshot => {
                const hostStatus = snapshot.val();
                if (!hostStatus) return;

                if (hostStatus.online === false && hostStatus.lastSeen) {
                    const now = Date.now();
                    const lastSeen = Number(hostStatus.lastSeen);
                    if (!isNaN(lastSeen) && now - lastSeen >= this.hostOfflineTimeoutMs) {
                        console.log("Host heartbeat lost. Triggering migration...");
                        this.handleHostMigration();
                    }
                }
            });
        }, 5000); // Check every 5 seconds

        onValue(this.gameRef, (snapshot) => {
            if (!snapshot.exists()) {
                alert("The game has been ended or the host has left.");
                location.reload();
                return;
            }
            const gameData = snapshot.val();

            if (gameData.players && !gameData.players[this.myId]) {
                alert("You have been removed from the game.");
                location.reload();
                return;
            }

            this.handleStateUpdate(gameData);
        });
    }
    async handleHostMigration() {
        const gameData = (await get(this.gameRef)).val();
        if (!gameData) return;

        const currentHostId = gameData.hostId;
        if (!currentHostId || currentHostId === this.myId) {
            return; // Either already no host or this client is host.
        }

        const currentHost = gameData.players?.[currentHostId];
        if (currentHost && currentHost.online === true) {
            return; // Host still available.
        }

        // Candidate set: active players who are not the old host.
        // WE MUST SORT ALPHABETICALLY TO ENSURE STABLE INDEXING ACROSS ALL CLIENTS
        const candidateIds = Object.keys(gameData.players || {}).sort().filter(pid => {
            if (pid === currentHostId) return false;
            const p = gameData.players[pid];
            return p && p.activeInRound !== false; // still eligible
        });

        // If no active player, fall back to any player except old host.
        const fallbackCandidates = Object.keys(gameData.players || {}).sort().filter(pid => pid !== currentHostId);
        const newHostId = candidateIds[0] || fallbackCandidates[0];

        if (!newHostId || newHostId !== this.myId) {
            return; // Only the chosen client should execute the promotion path.
        }

        this.showToast("Host lost connection; you are the new host.");
        this.isHost = true;

        // Write updated hostStatus.
        const hostStatusRef = ref(db, `games/${this.gameCode}/hostStatus`);
        set(hostStatusRef, {
            hostId: this.myId,
            online: true,
            lastSeen: serverTimestamp(),
            migrating: false
        });

        const updates = {
            hostId: this.myId,
            hostDisconnected: null
        };

        // Rotate turn if old host currently active player in playing state
        if (gameData.status === 'playing' && gameData.players[currentHostId] && Object.keys(gameData.players).sort()[gameData.turnIndex] === currentHostId) {
            const playerIds = Object.keys(gameData.players).sort();
            let nextIndex = gameData.turnIndex;
            let failsafe = 0;
            do {
                nextIndex = (nextIndex + 1) % playerIds.length;
                failsafe++;
            } while (failsafe < playerIds.length && gameData.players[playerIds[nextIndex]] && gameData.players[playerIds[nextIndex]].activeInRound === false);
            updates.turnIndex = nextIndex;
        }

        await update(this.gameRef, updates);
    }

    async togglePlayerActiveState(playerId) {
        if (!this.isHost) return;

        const currentState = (await get(this.gameRef)).val();
        const player = currentState.players[playerId];
        if (!player) return;

        // Host can manually manage players anytime.
        // FLIP LOGIC FIX: If the player is NOT currently explicitly false, they are 'active'.
        // Moving from 'active' means newState is now 'false' (spectator).
        const isCurrentlyActive = (player.activeInRound !== false);
        const newState = !isCurrentlyActive;

        const updates = {
            [`players/${playerId}/activeInRound`]: newState
        };

        // --- FIX FOR BUG #1: MID-ROUND ACTIVATION ---
        // If activating a player mid-game (not during lobby), they should not play this round
        if (newState === true && currentState.status === 'playing' && currentState.currentRound > 0) {
            // Add penalty for current round since they're being activated mid-round
            updates[`scores/${currentState.currentRound}/${playerId}`] = currentState.settings.latePenalty;
            this.showToast(`${player.name} will be active next round (penalty added for this round).`);
        } else if (newState === false) {
            // Making player inactive (spectator)
            const playerIds = Object.keys(currentState.players).sort();
            const currentPlayerId = playerIds[currentState.turnIndex];

            // If we are making the CURRENTLY active player a spectator, advance the turn
            if (currentPlayerId === playerId) {
                this.showToast(`${player.name}'s turn has been skipped.`);
                updates.turnIndex = this._getNextActivePlayerIndex(currentState, playerId);
                updates.turnPhase = 'discard'; // Reset phase for next player
            } else {
                this.showToast(`${player.name} is now a Spectator.`);
            }
        } else {
            this.showToast(`${player.name} is now Active (for next round).`);
        }

        await update(this.gameRef, updates);
    }
    handleStateUpdate(gameData) {
        // --- THIS IS THE NEW, CORRECTED LOGIC ---

        // 1. First, check if the host needs to take a special action.
        if (this.isHost && gameData.status === 'calculating_scores') {
            // If the host sees this status, their ONLY job is to calculate scores.
            // They should NOT try to render the game board in this state.
            this._calculateAndSetScores(gameData);
            return; // Stop processing this specific update immediately.
        }

        // 2. If no special action is needed, render the UI with the latest data.
        this.render(gameData);

        // 3. AFTER rendering, check if an animation needs to be triggered.
        if (
            this.lastGameState.status === 'playing' &&
            gameData.status === 'playing' &&
            gameData.turnIndex !== this.lastGameState.turnIndex
        ) {
            const lastPlayers = this.lastGameState.players;
            if (lastPlayers) { // Safety check
                const lastPlayerIds = Object.keys(lastPlayers).sort();
                const lastTurnPlayerId = lastPlayerIds[this.lastGameState.turnIndex];
                if (lastTurnPlayerId && lastTurnPlayerId !== this.myId && this.lastGameState.turnPhase === 'pick') {
                    const newDrawCount = (gameData.drawPile || []).length;
                    const oldDrawCount = (this.lastGameState.drawPile || []).length;
                    const newTrayCount = (gameData.tray || []).length;
                    const oldTrayCount = (this.lastGameState.tray || []).length;

                    if (newDrawCount < oldDrawCount) {
                        this.animateOpponentPick('draw', lastTurnPlayerId);
                    } else if (newTrayCount < oldTrayCount) {
                        this.animateOpponentPick('tray', lastTurnPlayerId);
                    }
                }
            }
        }

        // --- LIVE UI UPDATES (Stay Sync'd) ---
        // If the player list is currently open, we must re-render it to reflect changes (Spectator/Active buttons)
        const playerListScreen = document.getElementById('player-list-screen');
        if (playerListScreen && playerListScreen.classList.contains('active-screen')) {
            this.renderPlayerList(gameData);
        }

        // If the scoreboard is open, re-render it too
        const scoreboardScreen = document.getElementById('scoreboard-screen');
        if (scoreboardScreen && scoreboardScreen.classList.contains('active-screen')) {
            this.renderScoreboard(gameData);
        }

        // 4. FINALLY, update the game's "memory" for the next cycle.
        this.lastGameState = JSON.parse(JSON.stringify(gameData));
    }

    // --- GAME ACTIONS (WRITING TO FIREBASE) ---

    updateSettings() {
        if (!this.isHost) return;
        // --- FIX FOR BUG #15: Input validation for penalty ---
        let penalty = parseInt(document.getElementById('late-penalty-input').value);
        if (isNaN(penalty) || penalty < 0) {
            penalty = 10;
            document.getElementById('late-penalty-input').value = 10;
            this.showToast("Invalid penalty. Reset to 10.");
        }
        penalty = Math.max(0, Math.min(100, penalty)); // Cap between 0-100
        update(this.gameRef, { 'settings/latePenalty': penalty });
    }

    async kickPlayer(playerId) {
        if (!this.isHost) return;

        const gameData = (await get(this.gameRef)).val();
        if (!gameData.players[playerId]) return; // Player already gone

        const updates = { [`players/${playerId}`]: null };

        // Remove from scores
        if (gameData.scores) {
            Object.keys(gameData.scores).forEach(roundNum => {
                updates[`scores/${roundNum}/${playerId}`] = null;
            });
        }

        // --- CRITICAL ADDITION: Handle if the kicked player is the current turn ---
        const playerIds = Object.keys(gameData.players).sort();
        const currentPlayerId = playerIds[gameData.turnIndex];

        if (currentPlayerId === playerId) {
            // Use helper to find next valid player, skipping spectators AND the person being kicked
            updates.turnIndex = this._getNextActivePlayerIndex(gameData, playerId);
            updates.turnPhase = 'discard'; // Reset phase for next player
        }

        await update(this.gameRef, updates);
        this.showToast(`${gameData.players[playerId].name} has been kicked.`);
    }

    _getNextActivePlayerIndex(gameData, excludePlayerId = null) {
        const playerIds = Object.keys(gameData.players).sort();
        let nextIndex = gameData.turnIndex;
        let failsafe = 0;

        do {
            nextIndex = (nextIndex + 1) % playerIds.length;
            failsafe++;

            const nextPid = playerIds[nextIndex];
            const nextP = gameData.players[nextPid];

            // A candidate is valid if:
            // 1. They are NOT the one we are excluding (just kicked/spectated)
            // 2. They ARE active in the round
            if (nextPid !== excludePlayerId && nextP && nextP.activeInRound !== false) {
                return nextIndex;
            }
        } while (failsafe < playerIds.length);

        return nextIndex; // Fallback to current if nobody else active
    }

    async startGame() {
        if (!this.isHost) return;
        const snapshot = await get(ref(db, `games/${this.gameCode}/players`));
        if (Object.keys(snapshot.val() || {}).length < 2) return this.showToast("Need at least 2 players.");

        await this.startNewRound(1);
    }

    async startNewRound(roundNumber) {
        if (!this.isHost) return;

        const playersSnapshot = await get(ref(db, `games/${this.gameCode}/players`));
        const currentPlayers = playersSnapshot.val() || {};
        const playerIds = Object.keys(currentPlayers).sort();

        // --- FIX FOR BUG #4: Check if at least one player is or can be active ---
        const activePlayerCount = playerIds.filter(pid =>
            currentPlayers[pid] && currentPlayers[pid].activeInRound !== false
        ).length;

        if (activePlayerCount === 0 && roundNumber > 1) {
            // All players are spectators - force reactivate all players
            this.showToast("All players are spectators! Reactivating all for new round.");
            playerIds.forEach(pid => {
                if (currentPlayers[pid]) {
                    currentPlayers[pid].activeInRound = true;
                }
            });
        }

        let deck = this._createDeck();
        deck = this._shuffle(deck);

        const updates = {
            status: 'playing',
            currentRound: roundNumber,
            turnPhase: 'discard',
            tray: [deck.pop()],
            drawPile: deck,
            eligibleTrayCardIndex: 0,
            showPreviousCard: false,
            lastDiscardCount: 0
        };

        // Prepare a clean state for every player in the session
        playerIds.forEach(pid => {
            const player = currentPlayers[pid];
            if (player) {
                updates[`players/${pid}/hand`] = deck.splice(0, 7);
                updates[`players/${pid}/activeInRound`] = true;
            }
        });

        // Determine starting player: (roundNumber - 1) % playerIds.length
        // But skip any that somehow missing from the list
        let startingIdx = (roundNumber - 1) % playerIds.length;
        let failsafe = 0;
        while (!currentPlayers[playerIds[startingIdx]] && failsafe < playerIds.length) {
            startingIdx = (startingIdx + 1) % playerIds.length;
            failsafe++;
        }
        updates.turnIndex = startingIdx;

        await update(this.gameRef, updates);
    }

    async actionDiscard() {
        const gameData = (await get(this.gameRef)).val();
        const player = gameData.players[this.myId];
        const cardsToDiscard = this.selectedCardIndices.map(i => player.hand[i]).filter(c => c);

        // --- ADDED SAFETY CHECK ---
        if (cardsToDiscard.length > 1) {
            const firstVal = cardsToDiscard[0].v;
            if (!cardsToDiscard.every(c => c.v === firstVal)) {
                this.showToast("Cards must have the same value!");
                return;
            }
        }

        const newHand = player.hand.filter((_, index) => !this.selectedCardIndices.includes(index));

        const tray = gameData.tray || [];
        const eligibleTrayCardIndex = tray.length > 0 ? tray.length - 1 : -1;

        const newTray = [...tray, ...cardsToDiscard];

        this.selectedCardIndices = [];
        await update(this.gameRef, {
            [`players/${this.myId}/hand`]: newHand,
            'tray': newTray,
            'turnPhase': 'pick',
            'eligibleTrayCardIndex': eligibleTrayCardIndex,
            'lastDiscardCount': cardsToDiscard.length,
            'showPreviousCard': true
        });
    }

    async pickCard(source) {
        const gameData = (await get(this.gameRef)).val();
        const playerIds = Object.keys(gameData.players).sort();
        if (playerIds[gameData.turnIndex] !== this.myId || gameData.turnPhase !== 'pick') return;

        let pickedCard;
        let updates = {};
        let drawPile = gameData.drawPile || [];
        let tray = gameData.tray || [];

        // Check if there are any pickable cards at all
        const isDrawPileEmpty = drawPile.length === 0;
        const eligibleIndex = gameData.eligibleTrayCardIndex;
        const isTrayPickable = eligibleIndex > -1 && tray[eligibleIndex];
        const canReshuffle = tray.length > 1;

        if (isDrawPileEmpty && !isTrayPickable && !canReshuffle) {
            // --- THIS FIXES THE "STUCK TURN" BUG ---
            this.showToast("No cards to pick! Turn skipped.");
            // Force the turn to the next player without picking a card.
            let nextIndex = gameData.turnIndex;
            let currentTurn = nextIndex;
            do {
                nextIndex = (nextIndex + 1) % playerIds.length;
            } while (gameData.players[playerIds[nextIndex]] && gameData.players[playerIds[nextIndex]].activeInRound === false && nextIndex !== currentTurn);

            updates.turnIndex = nextIndex;
            updates.turnPhase = 'discard';
            updates.eligibleTrayCardIndex = null;
            await update(this.gameRef, updates);
            return;
        }

        if (source === 'draw') {
            if (drawPile.length === 0) {
                // Secure bridge for empty deck
                let keptCard = tray.pop();
                drawPile = this._shuffle(tray);
                tray = keptCard ? [keptCard] : [];
            }
            pickedCard = drawPile.pop();
        } else { // 'tray'
            if (!isTrayPickable) return;
            pickedCard = tray[eligibleIndex];
            tray.splice(eligibleIndex, 1);
            updates.showPreviousCard = false;
            updates.lastDiscardCount = 0;
        }

        // --- CRITICAL FIX: Ensure pickedCard actually exists ---
        if (!pickedCard) {
            this.showToast("No cards left in piles! Please wait for Host to refresh or try again.");
            return;
        }

        updates.drawPile = drawPile;
        updates.tray = tray;
        updates[`players/${this.myId}/hand`] = [...(gameData.players[this.myId].hand || []), pickedCard];

        // --- TURN ADVANCEMENT ---
        let nextIndex = (gameData.turnIndex + 1) % playerIds.length;
        let currentTurn = gameData.turnIndex;
        let pickFailsafe = 0;

        while (
            (gameData.players[playerIds[nextIndex]]?.activeInRound === false) &&
            nextIndex !== currentTurn &&
            pickFailsafe < playerIds.length
        ) {
            nextIndex = (nextIndex + 1) % playerIds.length;
            pickFailsafe++;
        }

        updates.turnIndex = nextIndex;
        updates.turnPhase = 'discard';
        updates.eligibleTrayCardIndex = null;

        await update(this.gameRef, updates);
    }

    async actionShow() {
        const gameData = (await get(this.gameRef)).val();
        const mySum = this._calculateHandSum(gameData.players[this.myId].hand);

        if (mySum > 5) return this.showToast("Sum must be 5 or less to show.");

        // --- THIS IS THE FINAL, SIMPLIFIED LOGIC ---
        // No matter who clicks the button (Host or Client), the action is the same:
        // Announce to the database that a "Show" has been initiated.
        await update(this.gameRef, {
            status: 'calculating_scores',
            showInitiatedBy: this.myId
        });
        // That's it. We now rely ENTIRELY on the onValue listener (in handleStateUpdate)
        // to react to this change, for ALL players, including the host.
        // This removes the race condition completely.
    }

    async _calculateAndSetScores(gameData) {
        if (gameData.status !== 'calculating_scores') {
            return;
        }

        const showerId = gameData.showInitiatedBy;
        if (!showerId || !gameData.players[showerId]) return;

        // --- THE FIX IS BELOW ---

        const playerIds = Object.keys(gameData.players).sort();
        const shower = gameData.players[showerId];
        const showerSum = this._calculateHandSum(shower.hand);
        let playerSums = {};
        playerIds.forEach(pid => {
            const player = gameData.players[pid];
            if (player) {
                // --- THIS IS THE FINAL, CRITICAL FIX ---
                // If a player is not active in this round (i.e., they joined late),
                // their sum for this calculation is considered the penalty score.
                if (player.activeInRound === false) {
                    playerSums[pid] = gameData.settings.latePenalty;
                } else {
                    // Otherwise, calculate their sum normally.
                    playerSums[pid] = this._calculateHandSum(player.hand);
                }
            }
        });
        const playersWhoBeatOrTied = Object.keys(playerSums).sort().filter(pid => playerSums[pid] <= showerSum);

        const updates = {
            status: 'round_over',
            showInitiatedBy: null
        };
        const roundScores = {};
        let message = "";

        if (playersWhoBeatOrTied.length === 1 && playersWhoBeatOrTied[0] === showerId) {
            message = `${shower.name} wins with the lowest score!`;
            playerIds.forEach(pid => {
                // CORRECTED LINE:
                if (gameData.players[pid]) roundScores[pid] = (pid === showerId) ? 0 : playerSums[pid];
            });
        } else {
            const penaltyCount = playersWhoBeatOrTied.filter(pid => pid !== showerId).length;
            const penalty = 30 * penaltyCount;
            message = `${shower.name} made a wrong show!`;
            if (showerSum === 0 && playersWhoBeatOrTied.length > 1) {
                message = `A 0-0 tie! Multiple players get 0.`;
            }
            playerIds.forEach(pid => {
                // CORRECTED LINE:
                if (gameData.players[pid]) {
                    if (playersWhoBeatOrTied.includes(pid)) {
                        roundScores[pid] = 0;
                    } else {
                        roundScores[pid] = playerSums[pid];
                    }
                }
            });
            roundScores[showerId] = penalty;
        }

        updates[`scores/${gameData.currentRound}`] = roundScores;
        updates.roundEndMessage = message;
        await update(this.gameRef, updates);

        setTimeout(async () => {
            if (this.isHost) {
                await this.startNewRound(gameData.currentRound + 1);
            }
        }, 15000);
    }

    showScoreboard() { document.getElementById('scoreboard-screen').classList.add('active-screen'); }
    closeScoreboard() { document.getElementById('scoreboard-screen').classList.remove('active-screen'); }
    // --- ADD THESE TWO NEW FUNCTIONS ---
    showHowToPlay() { document.getElementById('how-to-play-screen').classList.add('active-screen'); }
    closeHowToPlay() { document.getElementById('how-to-play-screen').classList.remove('active-screen'); }
    // --- CARD & DECK LOGIC (PRIVATE) ---

    showPlayerList() {
        // We call render one more time to ensure the list is up-to-date
        this.renderPlayerList(this.lastGameState);
        document.getElementById('player-list-screen').classList.add('active-screen');
    }

    closePlayerList() { document.getElementById('player-list-screen').classList.remove('active-screen'); }

    renderPlayerList(gameData) {
        const { players, hostId } = gameData;
        const listEl = document.getElementById('game-player-list');
        listEl.innerHTML = '';

        if (!players) return;

        Object.entries(players).sort((a, b) => a[0].localeCompare(b[0])).forEach(([pid, p]) => {
            if (!p) return;

            let li = document.createElement('li');
            const playerInfo = `<div>${p.name} ${pid === hostId ? '👑' : ''}</div>`;

            const buttonsContainer = document.createElement('div');

            if (this.isHost && pid !== this.myId) {
                // Button to toggle active/spectator state
                let toggleBtn = document.createElement('button');
                const isInactive = p.activeInRound === false;
                toggleBtn.innerText = isInactive ? 'Make Active' : 'Make Spectator';
                toggleBtn.className = 'toggle-active-btn';
                // Toggle button remains enabled for Host to manage players
                toggleBtn.onclick = () => this.togglePlayerActiveState(pid);
                buttonsContainer.appendChild(toggleBtn);

                // Existing Kick Button
                let kickBtn = document.createElement('button');
                kickBtn.innerText = 'Kick';
                kickBtn.className = 'kick-btn';
                kickBtn.onclick = () => this.kickPlayer(pid);
                buttonsContainer.appendChild(kickBtn);
            }

            li.innerHTML = playerInfo;
            li.appendChild(buttonsContainer);
            listEl.appendChild(li);
        });
    }

    _createDeck() {
        let deck = [];
        const SUITS = ['♥', '♦', '♣', '♠'];
        for (let d = 0; d < 2; d++) {
            for (let s of SUITS) {
                for (let v = 1; v <= 13; v++) deck.push({ v, s });
            }
        }
        for (let j = 0; j < 5; j++) deck.push({ v: 0, s: 'Joker' });
        return deck;
    }

    _shuffle(deck) {
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        return deck;
    }

    _getCardDisplay(card) {
        if (card.s === 'Joker') return { display: 'JOKER', color: 'black' };
        const color = ['♥', '♦'].includes(card.s) ? 'red' : 'black';
        let display;
        if (card.v === 1) display = 'A';
        else if (card.v === 11) display = 'J';
        else if (card.v === 12) display = 'Q';
        else if (card.v === 13) display = 'K';
        else display = card.v;
        return { display, color };
    }

    _calculateHandSum(hand) {
        if (!hand) return 0;
        return hand.reduce((sum, card) => sum + card.v, 0);
    }

    _toggleCardSelect(index, myHand) {
        if (this.selectedCardIndices.includes(index)) {
            this.selectedCardIndices = this.selectedCardIndices.filter(i => i !== index);
        } else {
            if (this.selectedCardIndices.length > 0) {
                const firstSelectedValue = myHand[this.selectedCardIndices[0]].v;
                if (myHand[index].v !== firstSelectedValue) {
                    this.selectedCardIndices = [index];
                } else {
                    this.selectedCardIndices.push(index);
                }
            } else {
                this.selectedCardIndices.push(index);
            }
        }
    }

    toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => {
                alert(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
            });
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            }
        }
    }
    animateOpponentPick(source, playerId) {
        const animationLayer = document.getElementById('animation-layer');
        const sourceEl = document.getElementById(source === 'draw' ? 'draw-pile' : 'discard-pile');
        const opponentEl = document.querySelector(`.opponent[data-pid="${playerId}"]`);

        if (!sourceEl || !opponentEl) return;

        const sourceRect = sourceEl.getBoundingClientRect();
        const opponentRect = opponentEl.getBoundingClientRect();
        const cardEl = document.createElement('div');

        if (source === 'tray') {
            const eligibleIndex = this.lastGameState.eligibleTrayCardIndex;
            const lastTray = this.lastGameState.tray;

            if (eligibleIndex > -1 && lastTray && lastTray[eligibleIndex]) {
                const pickedCardData = lastTray[eligibleIndex];

                // --- THIS IS THE CORRECTED LOGIC ---
                const { display, color } = this._getCardDisplay(pickedCardData);
                const isJoker = pickedCardData.s === 'Joker';

                cardEl.className = `card ${color} ${isJoker ? 'joker' : ''}`;
                cardEl.innerHTML = `<div class="card-corner">${display}<br>${isJoker ? '' : pickedCardData.s}</div>
                                    <div class="card-center">${isJoker ? 'JOKER' : pickedCardData.s}</div>
                                    <div class="card-corner bottom">${display}<br>${isJoker ? '' : pickedCardData.s}</div>`;
                // --- END OF CORRECTION ---

            } else {
                cardEl.className = 'card card-back';
            }
        } else {
            cardEl.className = 'card card-back';
        }

        cardEl.style.position = 'fixed';
        cardEl.style.left = `${sourceRect.left}px`;
        cardEl.style.top = `${sourceRect.top}px`;
        cardEl.style.width = `${sourceRect.width}px`;
        cardEl.style.height = `${sourceRect.height}px`;
        cardEl.style.transition = 'all 0.6s cubic-bezier(0.5, 0, 0.75, 0)';

        animationLayer.appendChild(cardEl);

        requestAnimationFrame(() => {
            cardEl.style.transform = `translate(${opponentRect.left - sourceRect.left}px, ${opponentRect.top - sourceRect.top}px) scale(0.2)`;
            cardEl.style.opacity = '0.5';
        });

        setTimeout(() => {
            if (animationLayer.contains(cardEl)) {
                animationLayer.removeChild(cardEl);
            }
        }, 650); // Slightly more buffer
    }

    // --- UI RENDERING ---

    render(gameData) {
        const { status, players, hostId, turnIndex, turnPhase, settings } = gameData;

        if (status === 'lobby') {
            if (!this.lastGameState || this.lastGameState.status !== 'lobby') {
                this.showScreen('lobby-screen');
            }
            document.getElementById('lobby-code-display').innerText = this.gameCode;
            document.getElementById('host-settings').style.display = this.isHost ? 'block' : 'none';
            document.getElementById('start-game-btn').style.display = this.isHost ? 'block' : 'none';
            document.getElementById('waiting-text').style.display = this.isHost ? 'none' : 'block';
            if (this.isHost) document.getElementById('late-penalty-input').value = settings.latePenalty;

            const list = document.getElementById('lobby-list');
            list.innerHTML = '';
            Object.entries(players || {}).sort((a, b) => a[0].localeCompare(b[0])).forEach(([pid, p]) => {
                let li = document.createElement('li');
                li.innerHTML = `<span>${p.name} ${pid === hostId ? '👑' : ''}</span>`;
                if (this.isHost && pid !== this.myId) {
                    let kickBtn = document.createElement('button');
                    kickBtn.innerText = 'Kick';
                    kickBtn.className = 'danger';
                    kickBtn.style.cssText = 'font-size:10px; padding: 4px 8px; margin:0;';
                    kickBtn.onclick = () => this.kickPlayer(pid);
                    li.appendChild(kickBtn);
                }
                list.appendChild(li);
            });
        } else if (status === 'playing' || status === 'round_over') { // NOTE: 'calculating_scores' is removed from here.
            if (!this.lastGameState || (this.lastGameState.status !== 'playing' && this.lastGameState.status !== 'round_over')) {
                this.showScreen('game-screen');
            }

            // The logic block for the host to calculate scores has been completely REMOVED from here.

            const playerIds = Object.keys(players).sort();
            const me = players[this.myId];
            if (!me) return;

            const myHand = me.hand || [];
            const currentPlayerId = playerIds[turnIndex];
            // Safety check for currentPlayer
            const currentPlayer = players[currentPlayerId] || { name: 'Unknown' };
            const isMyTurn = currentPlayerId === this.myId;

            // Top bar
            document.getElementById('game-room-id').innerText = this.gameCode;
            document.getElementById('round-indicator').innerText = `Round: ${gameData.currentRound}`;
            document.getElementById('turn-indicator').innerText = isMyTurn ? `YOUR TURN (${turnPhase.toUpperCase()})` : `${currentPlayer.name}'s Turn`;

            // Opponents
            this.renderOpponents(players, currentPlayerId);

            // Decks
            const drawPileEl = document.getElementById('draw-pile');
            const discardPileEl = document.getElementById('discard-pile');
            const drawPileCount = (gameData.drawPile || []).length;
            document.getElementById('draw-count').innerText = drawPileCount;

            // --- FIX FOR BUG #11: Hide draw pile visual when empty ---
            const drawPileVisual = document.getElementById('draw-pile-visual');
            drawPileVisual.style.display = drawPileCount > 0 ? 'block' : 'none';

            const tray = gameData.tray || [];
            const isMyPickPhase = isMyTurn && turnPhase === 'pick';

            const eligibleIndex = gameData.eligibleTrayCardIndex;
            const topCardToDisplay = (isMyPickPhase && eligibleIndex > -1 && tray[eligibleIndex])
                ? tray[eligibleIndex]
                : tray[tray.length - 1];

            // Get elements for two-card display
            const previousCardEl = document.getElementById('previous-card');
            const topCardEl = document.getElementById('top-card');
            const emptyText = document.getElementById('empty-tray-text');
            const countBadge = document.getElementById('card-count-badge');

            if (!topCardToDisplay) {
                // Empty tray
                if (previousCardEl) previousCardEl.style.display = 'none';
                if (topCardEl) topCardEl.style.display = 'none';
                if (emptyText) emptyText.style.display = 'block';
                if (countBadge) countBadge.style.display = 'none';
            } else {
                if (emptyText) emptyText.style.display = 'none';

                // Render top card
                const { display, color } = this._getCardDisplay(topCardToDisplay);
                const isJoker = topCardToDisplay.s === 'Joker';
                if (topCardEl) {
                    topCardEl.className = `card ${color}${isJoker ? ' joker' : ''}`;
                    topCardEl.innerHTML = `<div class="card-corner">${display}<br>${isJoker ? '' : topCardToDisplay.s}</div><div class="card-center">${isJoker ? 'JOKER' : topCardToDisplay.s}</div><div class="card-corner bottom">${display}<br>${isJoker ? '' : topCardToDisplay.s}</div>`;
                    topCardEl.style.display = 'block';
                }

                // Show previous card ONLY if flag is set (after discard, not after pick from tray)
                if (gameData.showPreviousCard && tray.length >= 2) {
                    const prevIndex = isMyPickPhase && eligibleIndex > -1 ? eligibleIndex - 1 : tray.length - 2;
                    const prevCard = tray[prevIndex];
                    if (prevCard && previousCardEl) {
                        const prevDisplay = this._getCardDisplay(prevCard);
                        const prevIsJoker = prevCard.s === 'Joker';
                        previousCardEl.className = `card ${prevDisplay.color}${prevIsJoker ? ' joker' : ''}`;
                        previousCardEl.innerHTML = `<div class="card-corner">${prevDisplay.display}<br>${prevIsJoker ? '' : prevCard.s}</div><div class="card-center">${prevIsJoker ? 'JOKER' : prevCard.s}</div><div class="card-corner bottom">${prevDisplay.display}<br>${prevIsJoker ? '' : prevCard.s}</div>`;
                        previousCardEl.style.display = 'block';
                    } else if (previousCardEl) {
                        previousCardEl.style.display = 'none';
                    }
                } else if (previousCardEl) {
                    previousCardEl.style.display = 'none';
                }

                // Show card count badge if multiple cards discarded
                const lastDiscardCount = gameData.lastDiscardCount || 0;
                if (lastDiscardCount > 1 && countBadge) {
                    countBadge.textContent = `x${lastDiscardCount}`;
                    countBadge.style.display = 'block';

                    // Smash effect for 3+ cards (only trigger once per discard)
                    if (lastDiscardCount >= 3 && topCardEl && !topCardEl.classList.contains('smash-triggered')) {
                        topCardEl.classList.add('smash-effect', 'smash-triggered');
                        this._createDustParticles();
                        setTimeout(() => {
                            topCardEl.classList.remove('smash-effect');
                        }, 500);
                    }
                } else if (countBadge) {
                    countBadge.style.display = 'none';
                    if (topCardEl) topCardEl.classList.remove('smash-triggered');
                }
            }

            // My Hand
            const handContainer = document.getElementById('hand-container');
            handContainer.innerHTML = '';

            // Improved card rendering with stable index mapping
            const mappedHand = myHand.map((card, originalIndex) => ({ card, originalIndex }));
            mappedHand.sort((a, b) => a.card.v - b.card.v).forEach(({ card, originalIndex }) => {
                const { display, color } = this._getCardDisplay(card);
                const isJoker = card.s === 'Joker';
                let cDiv = document.createElement('div');
                cDiv.className = `card ${color} ${isJoker ? 'joker' : ''}`;
                cDiv.dataset.index = originalIndex;
                cDiv.innerHTML = `<div class="card-corner">${display}<br>${isJoker ? '' : card.s}</div><div class="card-center">${isJoker ? 'JOKER' : card.s}</div><div class="card-corner bottom">${display}<br>${isJoker ? '' : card.s}</div>`;
                cDiv.onclick = () => {
                    if (isMyTurn && turnPhase === 'discard') {
                        this._toggleCardSelect(originalIndex, myHand);
                        this.render(gameData); // Re-rendering for selection is fine
                    }
                };
                if (this.selectedCardIndices.includes(originalIndex)) cDiv.classList.add('selected');
                handContainer.appendChild(cDiv);
            });

            // Controls
            const btnDiscard = document.getElementById('btn-discard');
            const btnShow = document.getElementById('btn-show');
            const currentSum = this._calculateHandSum(myHand);
            document.getElementById('hand-sum-display').innerText = `Sum: ${currentSum}`;

            btnDiscard.disabled = true;
            btnShow.disabled = true;
            drawPileEl.classList.remove('actionable');
            discardPileEl.classList.remove('actionable');

            if (isMyTurn) {
                if (turnPhase === 'discard') {
                    btnShow.disabled = currentSum > 5;
                    if (this.selectedCardIndices.length > 0) {
                        // --- FIX FOR BUG #6: Null check for selected cards ---
                        if (this.selectedCardIndices.length === 1) {
                            btnDiscard.disabled = false;
                        } else {
                            const selectedCards = this.selectedCardIndices.map(i => myHand[i]).filter(c => c); // Filter out undefined
                            if (selectedCards.length > 0) {
                                const allSame = selectedCards.every(c => c && c.v === selectedCards[0].v);
                                btnDiscard.disabled = !allSame;
                            } else {
                                btnDiscard.disabled = true;
                            }
                        }
                    }
                } else { // pick phase
                    drawPileEl.classList.add('actionable');
                    if (eligibleIndex > -1 && tray[eligibleIndex]) {
                        discardPileEl.classList.add('actionable');
                    }
                }
            }


            if (status === 'round_over') {
                this.renderScoreboard(gameData);
                document.getElementById('scoreboard-screen').classList.add('active-screen');
                document.getElementById('round-end-message').innerText = gameData.roundEndMessage || "Round Over!";
            }
        }
    }

    _createDustParticles() {
        const container = document.getElementById('discard-pile-visual');
        if (!container) return;

        for (let i = 0; i < 10; i++) {
            const dust = document.createElement('div');
            dust.className = 'dust-particle';
            const angle = (Math.random() * 360) * (Math.PI / 180);
            const distance = 30 + Math.random() * 30;
            dust.style.setProperty('--dust-x', `${Math.cos(angle) * distance}px`);
            dust.style.setProperty('--dust-y', `${Math.sin(angle) * distance}px`);
            dust.style.left = '50%';
            dust.style.top = '50%';
            container.appendChild(dust);
            setTimeout(() => dust.remove(), 600);
        }
    }

    renderScoreboard(gameData) {
        const table = document.getElementById('score-table');
        table.innerHTML = '';
        const players = gameData.players || {};
        // --- FIX FOR BUG #3: Filter out kicked/null players ---
        const playerIds = Object.keys(players).filter(pid => players[pid]).sort();
        if (playerIds.length === 0) return;

        // Header
        const thead = document.createElement('thead');
        let headerRow = '<tr><th>Round</th>';
        playerIds.forEach(pid => { headerRow += `<th>${players[pid].name}</th>` });
        headerRow += '</tr>';
        thead.innerHTML = headerRow;
        table.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');
        const totals = playerIds.reduce((acc, pid) => ({ ...acc, [pid]: 0 }), {});
        for (let r = 1; r <= gameData.currentRound; r++) {
            let row = `<tr><td>${r}</td>`;
            playerIds.forEach(pid => {
                const score = gameData.scores?.[r]?.[pid] ?? 0;
                row += `<td>${score}</td>`;
                totals[pid] += score;
            });
            row += '</tr>';
            tbody.innerHTML += row;
        }
        table.appendChild(tbody);

        // Footer
        const tfoot = document.createElement('tfoot');
        let footerRow = '<tr><td>TOTAL</td>';
        playerIds.forEach(pid => { footerRow += `<td>${totals[pid]}</td>` });
        footerRow += '</tr>';
        tfoot.innerHTML = footerRow;
        table.appendChild(tfoot);
    }
    renderOpponents(players, currentPlayerId) {
        const oppContainer = document.getElementById('opponents-container');
        oppContainer.innerHTML = '';
        const playerIds = Object.keys(players).filter(pid => players[pid]).sort();
        const opponentIds = playerIds.filter(pid => pid !== this.myId);

        if (opponentIds.length === 0) return;

        // Strategic positioning for up to 10 players
        // Avoid: top-center (0°, dealer) and bottom-center (180°, player)
        // Angles: 0° = right, 90° = bottom, 180° = left, 270° = top

        const positions = [
            { angle: 225, radius: 0.42 },  // Top-left
            { angle: 315, radius: 0.42 },  // Top-right
            { angle: 200, radius: 0.40 },  // Left-upper
            { angle: 340, radius: 0.40 },  // Right-upper
            { angle: 160, radius: 0.42 },  // Left-mid
            { angle: 20, radius: 0.42 },   // Right-mid
            { angle: 245, radius: 0.38 },  // Top-left-2
            { angle: 295, radius: 0.38 },  // Top-right-2
            { angle: 140, radius: 0.38 },  // Left-lower
            { angle: 40, radius: 0.38 },   // Right-lower
        ];

        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;

        opponentIds.forEach((pid, i) => {
            const p = players[pid];
            const pos = positions[i % positions.length];

            // Convert angle to radians
            const angleRad = pos.angle * (Math.PI / 180);
            const radiusX = window.innerWidth * pos.radius;
            const radiusY = window.innerHeight * pos.radius * 0.85;

            const x = centerX + radiusX * Math.cos(angleRad);
            const y = centerY + radiusY * Math.sin(angleRad);

            let div = document.createElement('div');
            div.className = `opponent ${pid === currentPlayerId ? 'active-turn' : ''}`;
            div.dataset.pid = pid;
            div.style.left = x + 'px';
            div.style.top = y + 'px';
            div.style.transform = 'translate(-50%, -50%)';
            div.innerHTML = `<div>${p.name}</div><div class="card-icon">🂠 ${(p.hand || []).length}</div>`;

            oppContainer.appendChild(div);
        });
    }
}

window.app = new PointGame();

window.addEventListener('load', () => {
    const params = new URLSearchParams(window.location.search);
    const gameCode = params.get('gameCode');
    if (gameCode) {
        document.getElementById('room-code-input').value = gameCode;
        app.showJoinInput();
        app.showToast("Enter your name to join!");
    }
});