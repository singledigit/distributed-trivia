/**
 * Seed script for QuestionsTable.
 *
 * Usage:
 *   npx tsx scripts/seed.ts [tableName]
 *
 * Defaults to "trivia-questions" if no table name is provided.
 * Uses AWS profile "demo" and region "us-west-2".
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { fromIni } from "@aws-sdk/credential-providers";

// ---------------------------------------------------------------------------
// ULID generator (mirrors shared/ulid.ts)
// ---------------------------------------------------------------------------

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(now: number, length: number): string {
  let str = "";
  let remaining = now;
  for (let i = length; i > 0; i--) {
    const mod = remaining % 32;
    str = CROCKFORD_BASE32[mod] + str;
    remaining = (remaining - mod) / 32;
  }
  return str;
}

function encodeRandom(length: number): string {
  let str = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) {
    str += CROCKFORD_BASE32[bytes[i] % 32];
  }
  return str;
}

function generateUlid(): string {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Difficulty = "easy" | "medium" | "hard";

interface SeedQuestion {
  questionText: string;
  options: string[];
  correctAnswer: string;
  difficulty: Difficulty;
}

interface Category {
  categoryId: string;
  categoryName: string;
  questions: SeedQuestion[];
}

// ---------------------------------------------------------------------------
// Points mapping
// ---------------------------------------------------------------------------

const POINTS: Record<Difficulty, number> = {
  easy: 10,
  medium: 20,
  hard: 30,
};

// ---------------------------------------------------------------------------
// Seed data — Science & Nature
// ---------------------------------------------------------------------------

const scienceQuestions: SeedQuestion[] = [
  // ---- Easy (10) ----
  {
    questionText: "Water is made up of hydrogen and oxygen.",
    options: ["True", "False"],
    correctAnswer: "True",
    difficulty: "easy",
  },
  {
    questionText: "What planet is known as the Red Planet?",
    options: ["Venus", "Mars", "Jupiter", "Saturn"],
    correctAnswer: "Mars",
    difficulty: "easy",
  },
  {
    questionText: "Humans have four lungs.",
    options: ["True", "False"],
    correctAnswer: "False",
    difficulty: "easy",
  },
  {
    questionText: "What gas do plants absorb from the atmosphere?",
    options: ["Oxygen", "Nitrogen", "Carbon Dioxide", "Helium"],
    correctAnswer: "Carbon Dioxide",
    difficulty: "easy",
  },
  {
    questionText: "What is the largest organ in the human body?",
    options: ["Heart", "Liver", "Skin", "Brain"],
    correctAnswer: "Skin",
    difficulty: "easy",
  },
  {
    questionText: "Diamonds are made of carbon.",
    options: ["True", "False"],
    correctAnswer: "True",
    difficulty: "easy",
  },
  {
    questionText: "How many legs does a spider have?",
    options: ["6", "8", "10", "12"],
    correctAnswer: "8",
    difficulty: "easy",
  },
  {
    questionText: "What is the chemical symbol for gold?",
    options: ["Go", "Gd", "Au", "Ag"],
    correctAnswer: "Au",
    difficulty: "easy",
  },
  {
    questionText: "The Earth revolves around the Sun.",
    options: ["True", "False"],
    correctAnswer: "True",
    difficulty: "easy",
  },
  {
    questionText: "What force keeps us on the ground?",
    options: ["Magnetism", "Gravity", "Friction", "Inertia"],
    correctAnswer: "Gravity",
    difficulty: "easy",
  },
  // ---- Medium (10) ----
  {
    questionText: "What is the powerhouse of the cell?",
    options: ["Nucleus", "Ribosome", "Mitochondria", "Golgi Apparatus"],
    correctAnswer: "Mitochondria",
    difficulty: "medium",
  },
  {
    questionText: "Light travels faster than sound.",
    options: ["True", "False"],
    correctAnswer: "True",
    difficulty: "medium",
  },
  {
    questionText: "What element does 'O' represent on the periodic table?",
    options: ["Osmium", "Oganesson", "Oxygen", "Gold"],
    correctAnswer: "Oxygen",
    difficulty: "medium",
  },
  {
    questionText: "How many bones are in the adult human body?",
    options: ["186", "206", "226", "256"],
    correctAnswer: "206",
    difficulty: "medium",
  },
  {
    questionText: "What type of animal is a Komodo dragon?",
    options: ["Mammal", "Amphibian", "Reptile", "Bird"],
    correctAnswer: "Reptile",
    difficulty: "medium",
  },
  {
    questionText: "Antibiotics are effective against viruses.",
    options: ["True", "False"],
    correctAnswer: "False",
    difficulty: "medium",
  },
  {
    questionText: "What planet has the most moons in our solar system?",
    options: ["Jupiter", "Saturn", "Uranus", "Neptune"],
    correctAnswer: "Saturn",
    difficulty: "medium",
  },
  {
    questionText: "What part of the plant conducts photosynthesis?",
    options: ["Root", "Stem", "Leaf", "Flower"],
    correctAnswer: "Leaf",
    difficulty: "medium",
  },
  {
    questionText: "What is the speed of light in a vacuum (approx)?",
    options: [
      "300,000 km/s",
      "150,000 km/s",
      "500,000 km/s",
      "1,000,000 km/s",
    ],
    correctAnswer: "300,000 km/s",
    difficulty: "medium",
  },
  {
    questionText: "DNA stands for deoxyribonucleic acid.",
    options: ["True", "False"],
    correctAnswer: "True",
    difficulty: "medium",
  },
  // ---- Hard (10) ----
  {
    questionText: "What is the half-life of Carbon-14 (approximately)?",
    options: ["1,200 years", "5,730 years", "12,000 years", "50,000 years"],
    correctAnswer: "5,730 years",
    difficulty: "hard",
  },
  {
    questionText:
      "The Heisenberg Uncertainty Principle relates to position and momentum.",
    options: ["True", "False"],
    correctAnswer: "True",
    difficulty: "hard",
  },
  {
    questionText: "What is the most abundant gas in Earth's atmosphere?",
    options: ["Oxygen", "Carbon Dioxide", "Nitrogen", "Argon"],
    correctAnswer: "Nitrogen",
    difficulty: "hard",
  },
  {
    questionText: "What organelle is responsible for protein synthesis?",
    options: ["Lysosome", "Ribosome", "Vacuole", "Centriole"],
    correctAnswer: "Ribosome",
    difficulty: "hard",
  },
  {
    questionText: "What is the Mohs hardness of a diamond?",
    options: ["7", "8", "9", "10"],
    correctAnswer: "10",
    difficulty: "hard",
  },
  {
    questionText: "Entropy in a closed system tends to decrease over time.",
    options: ["True", "False"],
    correctAnswer: "False",
    difficulty: "hard",
  },
  {
    questionText:
      "What phenomenon causes a star to collapse into a black hole?",
    options: [
      "Nuclear Fusion",
      "Gravitational Collapse",
      "Thermal Expansion",
      "Magnetic Reversal",
    ],
    correctAnswer: "Gravitational Collapse",
    difficulty: "hard",
  },
  {
    questionText: "What is the chemical formula for sulfuric acid?",
    options: ["H2SO3", "H2SO4", "HCl", "HNO3"],
    correctAnswer: "H2SO4",
    difficulty: "hard",
  },
  {
    questionText:
      "What particle is exchanged between nucleons to hold the nucleus together?",
    options: ["Photon", "Gluon", "Pion", "W Boson"],
    correctAnswer: "Pion",
    difficulty: "hard",
  },
  {
    questionText:
      "What is the name of the boundary around a black hole beyond which nothing can escape?",
    options: [
      "Schwarzschild Radius",
      "Event Horizon",
      "Photon Sphere",
      "Singularity",
    ],
    correctAnswer: "Event Horizon",
    difficulty: "hard",
  },
];

// ---------------------------------------------------------------------------
// Seed data — Pop Culture
// ---------------------------------------------------------------------------

const popCultureQuestions: SeedQuestion[] = [
  // ---- Easy (10) ----
  {
    questionText: "The movie 'Frozen' was produced by Disney.",
    options: ["True", "False"],
    correctAnswer: "True",
    difficulty: "easy",
  },
  {
    questionText: "What is the name of Harry Potter's best friend (male)?",
    options: [
      "Draco Malfoy",
      "Neville Longbottom",
      "Ron Weasley",
      "Cedric Diggory",
    ],
    correctAnswer: "Ron Weasley",
    difficulty: "easy",
  },
  {
    questionText: "In 'The Lion King', what is Simba's father's name?",
    options: ["Scar", "Mufasa", "Rafiki", "Zazu"],
    correctAnswer: "Mufasa",
    difficulty: "easy",
  },
  {
    questionText: "Mario is a character created by Nintendo.",
    options: ["True", "False"],
    correctAnswer: "True",
    difficulty: "easy",
  },
  {
    questionText: "What color is Superman's cape?",
    options: ["Blue", "Red", "Yellow", "Green"],
    correctAnswer: "Red",
    difficulty: "easy",
  },
  {
    questionText: "What instrument does a drummer play?",
    options: ["Guitar", "Piano", "Drums", "Violin"],
    correctAnswer: "Drums",
    difficulty: "easy",
  },
  {
    questionText: "SpongeBob SquarePants lives in a pineapple under the sea.",
    options: ["True", "False"],
    correctAnswer: "True",
    difficulty: "easy",
  },
  {
    questionText: "What is the name of the toy cowboy in 'Toy Story'?",
    options: ["Buzz", "Woody", "Rex", "Slinky"],
    correctAnswer: "Woody",
    difficulty: "easy",
  },
  {
    questionText: "Which superhero is known as the 'Dark Knight'?",
    options: ["Spider-Man", "Iron Man", "Batman", "Thor"],
    correctAnswer: "Batman",
    difficulty: "easy",
  },
  {
    questionText: "Taylor Swift is a country-turned-pop music artist.",
    options: ["True", "False"],
    correctAnswer: "True",
    difficulty: "easy",
  },
  // ---- Medium (10) ----
  {
    questionText: "What year was the first iPhone released?",
    options: ["2005", "2006", "2007", "2008"],
    correctAnswer: "2007",
    difficulty: "medium",
  },
  {
    questionText:
      "In 'The Lord of the Rings', what is the name of Frodo's sword?",
    options: ["Glamdring", "Andúril", "Sting", "Orcrist"],
    correctAnswer: "Sting",
    difficulty: "medium",
  },
  {
    questionText: "The TV show 'Friends' is set in New York City.",
    options: ["True", "False"],
    correctAnswer: "True",
    difficulty: "medium",
  },
  {
    questionText: "Who directed the movie 'Inception'?",
    options: [
      "Steven Spielberg",
      "Christopher Nolan",
      "James Cameron",
      "Ridley Scott",
    ],
    correctAnswer: "Christopher Nolan",
    difficulty: "medium",
  },
  {
    questionText: "What band was Freddie Mercury the lead singer of?",
    options: ["The Beatles", "Led Zeppelin", "Queen", "Pink Floyd"],
    correctAnswer: "Queen",
    difficulty: "medium",
  },
  {
    questionText: "In Minecraft, you can mine diamonds with a wooden pickaxe.",
    options: ["True", "False"],
    correctAnswer: "False",
    difficulty: "medium",
  },
  {
    questionText:
      "What fictional country is Black Panther the king of?",
    options: ["Genovia", "Wakanda", "Zamunda", "Latveria"],
    correctAnswer: "Wakanda",
    difficulty: "medium",
  },
  {
    questionText: "Which artist painted the Mona Lisa?",
    options: [
      "Michelangelo",
      "Leonardo da Vinci",
      "Raphael",
      "Vincent van Gogh",
    ],
    correctAnswer: "Leonardo da Vinci",
    difficulty: "medium",
  },
  {
    questionText: "What is the highest-grossing film of all time (unadjusted)?",
    options: ["Avengers: Endgame", "Avatar", "Titanic", "Star Wars: The Force Awakens"],
    correctAnswer: "Avatar",
    difficulty: "medium",
  },
  {
    questionText: "The video game 'The Legend of Zelda' stars a character named Zelda.",
    options: ["True", "False"],
    correctAnswer: "False",
    difficulty: "medium",
  },
  // ---- Hard (10) ----
  {
    questionText: "What year did the original 'Star Wars' (Episode IV) premiere?",
    options: ["1975", "1977", "1979", "1980"],
    correctAnswer: "1977",
    difficulty: "hard",
  },
  {
    questionText:
      "In the TV series 'Breaking Bad', what is Walter White's street name?",
    options: ["The Cook", "Heisenberg", "Blue Sky", "The Chemist"],
    correctAnswer: "Heisenberg",
    difficulty: "hard",
  },
  {
    questionText:
      "What was the first feature-length animated film ever released?",
    options: [
      "Snow White and the Seven Dwarfs",
      "Fantasia",
      "Pinocchio",
      "Bambi",
    ],
    correctAnswer: "Snow White and the Seven Dwarfs",
    difficulty: "hard",
  },
  {
    questionText: "The character Darth Vader was voiced by James Earl Jones.",
    options: ["True", "False"],
    correctAnswer: "True",
    difficulty: "hard",
  },
  {
    questionText:
      "Which author wrote the dystopian novel '1984'?",
    options: [
      "Aldous Huxley",
      "Ray Bradbury",
      "George Orwell",
      "Philip K. Dick",
    ],
    correctAnswer: "George Orwell",
    difficulty: "hard",
  },
  {
    questionText:
      "What is the name of the fictional metal in the Marvel universe that Captain America's shield is made of?",
    options: ["Adamantium", "Vibranium", "Uru", "Carbonadium"],
    correctAnswer: "Vibranium",
    difficulty: "hard",
  },
  {
    questionText:
      "In the 'Matrix' trilogy, what color pill does Neo take?",
    options: ["Blue", "Red", "Green", "White"],
    correctAnswer: "Red",
    difficulty: "hard",
  },
  {
    questionText:
      "What was the first music video played on MTV when it launched in 1981?",
    options: [
      "Thriller by Michael Jackson",
      "Video Killed the Radio Star by The Buggles",
      "Bohemian Rhapsody by Queen",
      "Take On Me by a-ha",
    ],
    correctAnswer: "Video Killed the Radio Star by The Buggles",
    difficulty: "hard",
  },
  {
    questionText:
      "The Konami Code is: Up, Up, Down, Down, Left, Right, Left, Right, B, A.",
    options: ["True", "False"],
    correctAnswer: "True",
    difficulty: "hard",
  },
  {
    questionText:
      "Which Studio Ghibli film won the Academy Award for Best Animated Feature in 2003?",
    options: [
      "My Neighbor Totoro",
      "Princess Mononoke",
      "Spirited Away",
      "Howl's Moving Castle",
    ],
    correctAnswer: "Spirited Away",
    difficulty: "hard",
  },
];

// ---------------------------------------------------------------------------
// Build categories
// ---------------------------------------------------------------------------

const categories: Category[] = [
  {
    categoryId: generateUlid(),
    categoryName: "Science & Nature",
    questions: scienceQuestions,
  },
  {
    categoryId: generateUlid(),
    categoryName: "Pop Culture",
    questions: popCultureQuestions,
  },
];

// ---------------------------------------------------------------------------
// DynamoDB helpers
// ---------------------------------------------------------------------------

function buildItems(tableName: string) {
  const items: Record<string, unknown>[] = [];

  for (const cat of categories) {
    // Category METADATA record
    items.push({
      PK: `CATEGORY#${cat.categoryId}`,
      SK: "METADATA",
      categoryId: cat.categoryId,
      categoryName: cat.categoryName,
    });

    // Question records
    for (const q of cat.questions) {
      const questionId = generateUlid();
      items.push({
        PK: `CATEGORY#${cat.categoryId}`,
        SK: `QUESTION#${questionId}`,
        questionId,
        questionText: q.questionText,
        options: q.options,
        correctAnswer: q.correctAnswer,
        difficulty: q.difficulty,
        points: POINTS[q.difficulty],
      });
    }
  }

  return items;
}

/** Split an array into chunks of a given size. */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function seed(tableName: string) {
  const client = new DynamoDBClient({
    region: "us-west-2",
    credentials: fromIni({ profile: "demo" }),
  });
  const ddb = DynamoDBDocumentClient.from(client);

  const items = buildItems(tableName);
  const batches = chunk(items, 25);

  console.log(`Seeding ${items.length} items into "${tableName}" in ${batches.length} batches...`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const requestItems = {
      [tableName]: batch.map((item) => ({
        PutRequest: { Item: item },
      })),
    };

    const result = await ddb.send(
      new BatchWriteCommand({ RequestItems: requestItems })
    );

    // Handle unprocessed items with simple retry
    let unprocessed = result.UnprocessedItems;
    let retries = 0;
    while (unprocessed && Object.keys(unprocessed).length > 0 && retries < 3) {
      retries++;
      const unprocessedCount = unprocessed[tableName]?.length ?? 0;
      console.log(`  Batch ${i + 1}: retrying ${unprocessedCount} unprocessed items (attempt ${retries})...`);
      await new Promise((r) => setTimeout(r, 1000 * retries)); // backoff
      const retry = await ddb.send(
        new BatchWriteCommand({ RequestItems: unprocessed })
      );
      unprocessed = retry.UnprocessedItems;
    }

    console.log(`  Batch ${i + 1}/${batches.length} written (${batch.length} items)`);
  }

  // Print summary
  console.log("\nSeed complete!");
  for (const cat of categories) {
    const easy = cat.questions.filter((q) => q.difficulty === "easy").length;
    const medium = cat.questions.filter((q) => q.difficulty === "medium").length;
    const hard = cat.questions.filter((q) => q.difficulty === "hard").length;
    const tf = cat.questions.filter((q) => q.options.length === 2).length;
    console.log(
      `  ${cat.categoryName} (${cat.categoryId}): ${cat.questions.length} questions (${easy} easy, ${medium} medium, ${hard} hard, ${tf} true/false)`
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const tableName =
  process.env.QUESTIONS_TABLE_NAME ?? process.argv[2] ?? "trivia-questions";

seed(tableName).catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
