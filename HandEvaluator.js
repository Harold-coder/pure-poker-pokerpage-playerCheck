const cardValues = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, 'T': 10,
    'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

function getCardFrequency(hand) {
    const frequency = {};
    hand.forEach(card => {
        if (typeof card !== 'string') {
            throw new Error(`Expected a string, but got: ${typeof card}`);
        }
        const value = card.slice(0, -1);
        frequency[value] = (frequency[value] || 0) + 1;
    });
    return frequency;
}


function evaluateBestHand(sevenCardHand) {
    const allFiveCardCombinations = getCombinations(sevenCardHand, 5);
    let bestHand = null;
    allFiveCardCombinations.forEach(fiveCardHand => {
        if (!bestHand || compareHands(fiveCardHand, bestHand) < 0) {
            bestHand = fiveCardHand;
        }
    });
    return {
        bestHand: bestHand,
        description: evaluateHand(bestHand).rank // Assuming evaluateHand returns a 'description' field
    };
}

function getCombinations(array, size) {
    const result = [];
    function helper(start, chosen) {
        if (chosen.length === size) {
            result.push(chosen.slice());
            return;
        }
        for (let i = start; i < array.length; i++) {
            chosen.push(array[i]);
            helper(i + 1, chosen);
            chosen.pop();
        }
    }
    helper(0, []);
    return result;
}

function sortHand(hand) {
    return hand.sort((a, b) => cardValues[a[0]] - cardValues[b[0]]);
}

function evaluateHand(hand) {
    const frequency = getCardFrequency(hand);
    let pairs = [], threeOfAKinds = [], fourOfAKinds = [];
    let kickers = [];

    hand.forEach(card => {
        const cardRank = card.slice(0, -1);
        const count = frequency[cardRank];
        if (count === 2 && !pairs.includes(cardRank)) pairs.push(cardRank);
        else if (count === 3 && !threeOfAKinds.includes(cardRank)) threeOfAKinds.push(cardRank);
        else if (count === 4 && !fourOfAKinds.includes(cardRank)) fourOfAKinds.push(cardRank);
        else if (count === 1) kickers.push(cardRank);
    });

    const sortedHand = sortHand(hand);
    const isFlushHand = isFlush(sortedHand);
    const isStraightHand = isStraight(sortedHand);

    if (isFlushHand && isStraightHand) return { rank: "Straight Flush", value: 9, cards: sortedHand.map(card => card.slice(0, -1)) };
    if (fourOfAKinds.length > 0) return { rank: "Four of a Kind", value: 8, quads: fourOfAKinds[0], kickers };
    if (threeOfAKinds.length > 0 && pairs.length > 0) return { rank: "Full House", value: 7, three: threeOfAKinds[0], pair: pairs[0] };
    if (isFlushHand) return { rank: "Flush", value: 6, cards: sortedHand.map(card => card.slice(0, -1)) };
    if (isStraightHand) return { rank: "Straight", value: 5, cards: sortedHand.map(card => card.slice(0, -1)) };
    if (threeOfAKinds.length > 0) return { rank: "Three of a Kind", value: 4, trips: threeOfAKinds[0], kickers };
    if (pairs.length > 1) return { rank: "Two Pair", value: 3, pairs, kickers };
    if (pairs.length === 1) return { rank: "One Pair", value: 2, pair: pairs[0], kickers };
    return { rank: "High Card", value: 1, cards: kickers };
}

function isFlush(hand) {
    const suit = hand[0].slice(-1);
    return hand.every(card => card.slice(-1) === suit);
}

function isStraight(hand) {
    const values = hand.map(card => cardValues[card[0]]);
    values.sort((a, b) => a - b);

    // Check for a standard straight first
    for (let i = 0; i < values.length - 1; i++) {
        if (values[i + 1] - values[i] !== 1) {
            // Not a consecutive sequence, check for Ace-low straight
            const isAceLowStraight = values[0] === 2 && values[1] === 3 && values[2] === 4 && values[3] === 5 && values[4] === 14;
            return isAceLowStraight;
        }
    }
    // If the loop completes without returning false, it's a straight
    return true;
}


function compareCardSets(cards1, cards2) {
    cards1.sort((a, b) => cardValues[b] - cardValues[a]);
    cards2.sort((a, b) => cardValues[b] - cardValues[a]);

    for (let i = 0; i < Math.min(cards1.length, cards2.length); i++) {
        const result = compareHighCard(cards1[i], cards2[i]);
        if (result !== 0) return result;
    }
    return 0; // All compared cards are equal
}

function compareHands(hand1, hand2) {
    const eval1 = evaluateHand(hand1);
    const eval2 = evaluateHand(hand2);

    if (eval2.value > eval1.value) return 1;
    if (eval2.value < eval1.value) return -1;

    let result;

    switch (eval1.rank) {
        case "Straight Flush":
        case "Flush":
        case "Straight":
        case "High Card":
            return compareCardSets(eval1.cards, eval2.cards);
        case "Four of a Kind":
        case "Three of a Kind":
            result = compareHighCard(eval1.quads || eval1.trips, eval2.quads || eval2.trips);
            if (result !== 0) return result;
            return compareKickers(eval1.kickers, eval2.kickers);
        case "Full House":
            result = compareHighCard(eval1.three, eval2.three);
            if (result !== 0) return result;
            return compareHighCard(eval1.pair, eval2.pair);
        case "Two Pair":
            result = compareCardSets(eval1.pairs, eval2.pairs);
            if (result !== 0) return result;
            return compareKickers(eval1.kickers, eval2.kickers);
        case "One Pair":
            result = compareHighCard(eval1.pair, eval2.pair);
            if (result !== 0) return result;
            return compareKickers(eval1.kickers, eval2.kickers);
        default:
            console.error("Unhandled hand rank comparison");
            return 0;
    }
}

function compareHighCard(card1, card2) {
    const value1 = cardValues[card1];
    const value2 = cardValues[card2];
    return (value2 - value1); // Higher value wins
}

function compareKickers(kickers1, kickers2) {
    // Sort kickers in descending order based on their values
    kickers1.sort((a, b) => cardValues[b] - cardValues[a]);
    kickers2.sort((a, b) => cardValues[b] - cardValues[a]);

    // Compare each kicker in order
    for (let i = 0; i < Math.min(kickers1.length, kickers2.length); i++) {
        const comparison = compareHighCard(kickers1[i], kickers2[i]);
        if (comparison !== 0) return comparison;
    }
    return 0; // All compared kickers are equal
}

module.exports = { evaluateBestHand, compareHands };