//index.js
const AWS = require('aws-sdk');
const Helpers = require('UpdateGame');
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const gameTableName = process.env.GAME_TABLE;
const connectionsTableName = process.env.CONNECTIONS_TABLE;
const apiGatewayManagementApi = new AWS.ApiGatewayManagementApi({
    endpoint: process.env.WEBSOCKET_ENDPOINT
});

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

        const allInConditionMet = Helpers.checkAllInCondition(game);
        if (!allInConditionMet) {
            if (Helpers.allPlayersHaveActed(game)) {
                Helpers.advanceGameStage(game); // This should include saving the updated game state and notifying players
            } else {
                Helpers.advanceTurn(game); // This should include saving the updated game state and notifying players
            }
        }
        await saveGameState(gameId, game);
        await notifyAllPlayers(gameId, game);
        
        return { statusCode: 200, body: 'Check action processed.' };
    } catch (error) {
        console.error('Error processing playerCheck:', error);
        // Optionally, send an error message back to the checker
        await apiGatewayManagementApi.postToConnection({
            ConnectionId: connectionId,
            Data: JSON.stringify({ error: error.message })
        }).promise();

        return { statusCode: 500, body: JSON.stringify({ message: error.message }) };
    }
};
//
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
        UpdateExpression: "SET players = :p, gameOverTimeStamp = :gOTS, bettingStarted = :bS, minRaiseAmount = :mRA, deck = :deck, pot = :pot, gameStage = :gs, currentTurn = :ct, communityCards = :cc, highestBet = :hb, gameInProgress = :gip, netWinners = :nw",
        ExpressionAttributeValues: {
            ":p": game.players,
            ":gOTS": game.gameOverTimeStamp,
            ":bS": game.bettingStarted,
            ":mRA": game.minRaiseAmount,
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
        await apiGatewayManagementApi.postToConnection({ 
            ConnectionId: connectionId,
             Data: JSON.stringify({
                game: game,
                action: "playerCheck",
                statusCode: 200
            }) 
        }).promise();
    });
    await Promise.all(postCalls);
}