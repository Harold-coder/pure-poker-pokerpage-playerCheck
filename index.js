//index.js
const AWS = require('aws-sdk');
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const Deck = require('./Deck');
const { evaluateBestHand, compareHands } = require('./HandEvaluator');
const gameTableName = process.env.GAME_TABLE;
const connectionsTableName = process.env.CONNECTIONS_TABLE;
const apiGatewayManagementApi = new AWS.ApiGatewayManagementApi({
    endpoint: process.env.WEBSOCKET_ENDPOINT
});

const GAME_STAGES = {
    PRE_DEALING: 'preDealing',
    PRE_FLOP: 'preFlop',
    FLOP: 'flop',
    TURN: 'turn',
    RIVER: 'river',
    GAME_OVER: 'gameOver'
};

function determineWinner(game) {
    let remainingPot = game.pot;

    // Create a temporary copy of pot contributions for calculations
    let potContributionsCopy = game.players.map(player => ({
        id: player.id,
        potContribution: player.potContribution
    }));

    // Evaluate hands for all players and update their objects
    game.players.forEach(player => {
        const handResult = evaluateBestHand([...player.hand, ...game.communityCards]);
        player.handDescription = handResult.description;
        player.bestHand = handResult.bestHand;
    });

    let sortedPlayers = game.players.filter(p => p.inHand)
        .sort((a, b) => potContributionsCopy.find(pc => pc.id === a.id).potContribution - potContributionsCopy.find(pc => pc.id === b.id).potContribution);

    while (sortedPlayers.length > 0 && remainingPot > 0) {
        const minContribution = potContributionsCopy.filter(pc => sortedPlayers.some(sp => sp.id === pc.id))[0].potContribution;
        let potToDistribute = minContribution * sortedPlayers.length;
        remainingPot -= potToDistribute;

        const handEvaluations = sortedPlayers.map(player => ({
            playerId: player.id,
            bestHand: player.bestHand
        }));

        handEvaluations.sort((a, b) => compareHands(a.bestHand, b.bestHand));
        const winners = handEvaluations.filter(e => compareHands(e.bestHand, handEvaluations[0].bestHand) === 0);

        const share = potToDistribute / winners.length;
        winners.forEach(winner => {
            const player = game.players.find(p => p.id === winner.playerId);
            player.chips += share;
            player.amountWon = (player.amountWon || 0) + share;

            if ((player.amountWon - player.potContribution) > 0 && !game.netWinners.includes(winner.playerId)) {
                game.netWinners.push(winner.playerId);
            }
        });

        // Deduct the distributed pot from the temporary pot contributions
        potContributionsCopy.forEach(pc => {
            if (sortedPlayers.some(sp => sp.id === pc.id)) {
                pc.potContribution -= minContribution;
            }
        });

        // Filter for the next iteration
        sortedPlayers = sortedPlayers.filter(sp => potContributionsCopy.find(pc => pc.id === sp.id).potContribution > 0);
    }

    if (remainingPot > 0 && game.netWinners.length > 0) {
        const remainingShare = remainingPot / game.netWinners.length;
        game.netWinners.forEach(winnerId => {
            const player = game.players.find(p => p.id === winnerId);
            player.chips += remainingShare;
            player.amountWon += remainingShare;
        });
    }

    game.pot = 0;
    game.gameStage = GAME_STAGES.GAME_OVER;
}

function check(playerId, players, highestBet) {
    const playerIndex = players.findIndex(player => player.id === playerId);
    const player = players[playerIndex];

    if (player.bet < highestBet) {
        console.error("Cannot check, player must call or fold");
        return { actionSuccessful: false, updatedPlayers: players };
    } else {
        players[playerIndex] = {
            ...player,
            hasActed: true
        };
        return { actionSuccessful: true, updatedPlayers: players };
    }
}

function checkAllInCondition(game) {
    const activePlayers = game.players.filter(p => p.inHand);
    const allInPlayers = activePlayers.filter(p => p.isAllIn);

    if (allInPlayers.length === activePlayers.length) {
        revealAllCommunityCards(game);
        determineWinner(game);
        return true; // Condition met, all players are all-in
    } else if (allInPlayers.length === activePlayers.length - 1) {
        const lastPlayer = activePlayers.find(p => !p.isAllIn);

        // Check if the last player has matched the highest bet, is all-in, or has folded
        if (lastPlayer.bet === game.highestBet) {
            revealAllCommunityCards(game);
            determineWinner(game);
            return true; // Condition met, last player has responded appropriately
        }
    }

    return false; // Condition not met, game should not advance yet
}

function revealAllCommunityCards(game) {
    const cardsDealt = game.communityCards.length;
    if (cardsDealt < 3) {
        dealCommunityCards(game, 3 - cardsDealt);
    }
    if (cardsDealt < 4) {
        dealCommunityCards(game, 4 - game.communityCards.length);
    }
    if (cardsDealt < 5) {
        dealCommunityCards(game, 5 - game.communityCards.length);
    }
}

function dealCommunityCards(game, count) {
    // Check if game.deck is an instance of Deck, if not, reinstantiate it
    if (!(game.deck instanceof Deck)) {
        const deck = new Deck();
        deck.cards = game.deck.cards; // Assuming game.deck.cards holds the array of cards
        game.deck = deck;
    }

    const cards = game.deck.deal(count);
    game.communityCards.push(...cards);
}

function advanceTurn(game) {
    let nextTurn = (game.currentTurn + 1) % game.players.length;
    while (!game.players[nextTurn].inHand || game.players[nextTurn].chips === 0) {
        nextTurn = (nextTurn + 1) % game.players.length;
    }

    // Update the game state with the new current turn
    game.currentTurn = nextTurn;
}

function findFirstActivePlayer(game) {
    let startIndex = game.smallBlindIndex
    for (let i = 0; i < game.playerCount; i++) {
        let currentIndex = (startIndex + i) % game.playerCount;
        let currentPlayer = game.players[currentIndex];

        if (currentPlayer.inHand && currentPlayer.chips > 0) {
            return currentIndex;
        }
    }

    return -1;
}

function advanceGameStage(game) {
    game.players.forEach(player => {
        player.bet = 0;
        player.hasActed = !player.inHand;
    });
    game.highestBet = 0;
    game.bettingStarted = false;
    game.minRaiseAmount = game.initialBigBlind;

    switch (game.gameStage) {
        case GAME_STAGES.PRE_FLOP:
            dealCommunityCards(game, 3);
            game.gameStage = GAME_STAGES.FLOP;
            break;
        case GAME_STAGES.FLOP:
            dealCommunityCards(game, 1);
            game.gameStage = GAME_STAGES.TURN;
            break;
        case GAME_STAGES.TURN:
            dealCommunityCards(game, 1);
            game.gameStage = GAME_STAGES.RIVER;
            break;
        case GAME_STAGES.RIVER:
            determineWinner(game); // Ensure this function saves the updated game state
            return; // Exit after determining the winner, since it should handle saving and broadcasting the game state
    }

    if (game.gameStage !== GAME_STAGES.GAME_OVER) {
        game.currentTurn = findFirstActivePlayer(game);
    }
}

exports.handler = async (event) => {
    const { gameId, playerId } = JSON.parse(event.body);
    const connectionId = event.requestContext.connectionId;

    try {
        const game = await getGameState(gameId);
        if (!game) {
            console.error(`Game with ID ${gameId} not found`);
            throw new Error('Game not found');
        }

        if (game.gameStage === 'gameOver') {
            throw new Error("The game is over. No more actions allowed.");
        }

        const playerIndex = game.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1 || game.players[playerIndex].position !== game.currentTurn) {
            throw new Error(`It's not this player's turn or the player ID ${playerId} not found in game ${gameId}`);
        }

        const { actionSuccessful, updatedPlayers } = check(
            playerId,
            game.players,
            game.highestBet
        );

        if (!actionSuccessful) {
            throw new Error("Call action was not successful.");
        }

        game.players = updatedPlayers;

        const allInConditionMet = checkAllInCondition(game);
        if (!allInConditionMet) {
            if (allPlayersHaveActed(game)) {
                advanceGameStage(game); // This should include saving the updated game state and notifying players
            } else {
                advanceTurn(game); // This should include saving the updated game state and notifying players
            }
        }
        await saveGameState(gameId, game);
        await notifyAllPlayers(gameId, game);
        
        return { statusCode: 200, body: 'Call action processed.' };
    } catch (error) {
        console.error('Error processing playerCall:', error);
        // Optionally, send an error message back to the caller
        await apiGatewayManagementApi.postToConnection({
            ConnectionId: connectionId,
            Data: JSON.stringify({ error: error.message })
        }).promise();

        return { statusCode: 500, body: JSON.stringify({ message: error.message }) };
    }
};

async function getGameState(gameId) {
    const params = {
        TableName: gameTableName,
        Key: { gameId },
    };
    const { Item } = await dynamoDb.get(params).promise();
    return Item;
}

async function saveGameState(gameId, game) {
    const params = {
        TableName: gameTableName,
        Key: { gameId },
        UpdateExpression: "SET players = :p, deck = :deck, pot = :pot, gameStage = :gs, currentTurn = :ct, communityCards = :cc, highestBet = :hb, gameInProgress = :gip, netWinners = :nw",
        ExpressionAttributeValues: {
            ":p": game.players,
            ":pot": game.pot,
            ":gs": game.gameStage,
            ":ct": game.currentTurn,
            ":cc": game.communityCards,
            ":hb": game.highestBet,
            ":gip": game.gameInProgress,
            ":nw": game.netWinners,
            ":deck": game.deck
        },
        ReturnValues: "UPDATED_NEW"
    };
    await dynamoDb.update(params).promise();
}


async function notifyAllPlayers(gameId, game) {
    // Retrieve all connection IDs for this game from the connections table
    const connectionData = await dynamoDb.scan({ TableName: connectionsTableName, FilterExpression: "gameId = :gameId", ExpressionAttributeValues: { ":gameId": gameId } }).promise();
    const postCalls = connectionData.Items.map(async ({ connectionId }) => {
        await apiGatewayManagementApi.postToConnection({ ConnectionId: connectionId, Data: JSON.stringify(game) }).promise();
    });
    await Promise.all(postCalls);
}