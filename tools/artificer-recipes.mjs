#!/usr/bin/env node
// Generates the "D&D 2024 Artificer Recipes" (packs-src/artificer-recipes).
// The Artificer is not part of the PHB / SRD 5.2: the recipes only name the features and the items, no rules text.
// Items and icons are taken from the Dungeon Master's Guide and Player's Handbook modules when they are installed,
// otherwise from the SRD (dnd5e.equipment24). Which item is really given is decided when it is crafted (src/main.js).
//
// Usage: node tools/artificer-recipes.mjs [path to Foundry's Data folder]
//        default: the Data folder above package.json "devDir"

import { extractPack } from "@foundryvtt/foundryvtt-cli";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const DATA = process.argv[2] || path.join(PACKAGE.devDir, "..");
const PACK = "artificer-recipes";
const OUT = path.join(ROOT, "packs-src", PACK);
const NS = PACKAGE.name;

/** reads a LevelDB pack from a copy: Foundry keeps the original locked while it runs */
async function readPack(packPath) {
  if (!fs.existsSync(packPath)) return [];
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "bac-pack-"));
  fs.cpSync(packPath, copy, { recursive: true });
  fs.rmSync(path.join(copy, "LOCK"), { force: true });
  const items = [];
  // collects the documents only, nothing is written
  await extractPack(copy, copy, {
    transformEntry: (doc) => {
      if (doc._key?.startsWith("!items!")) items.push(doc);
      return false;
    },
  });
  fs.rmSync(copy, { recursive: true, force: true });
  return items;
}

// the books win over the SRD (same order as at runtime)
const SOURCES = [
  { id: "dnd-dungeon-masters-guide.equipment", dir: "modules/dnd-dungeon-masters-guide/packs/equipment" },
  { id: "dnd-players-handbook.equipment", dir: "modules/dnd-players-handbook/packs/equipment" },
  { id: "dnd5e.equipment24", dir: "systems/dnd5e/packs/equipment24" },
];
for (const s of SOURCES) {
  s.items = await readPack(path.join(DATA, s.dir));
  console.log(`${s.id}: ${s.items.length} items${s.items.length ? "" : " (not installed: icons and lists from the SRD)"}`);
}
const srd = SOURCES.at(-1).items;
const dmg = SOURCES[0].items;
if (!srd.length) throw new Error("dnd5e.equipment24 not found in " + DATA);

/** the first source that has an item of this name (and type) */
function find(name, type) {
  for (const s of SOURCES) {
    // some items are also in the contents of an equipment pack: take the one that is not
    const hits = s.items.filter((i) => i.name === name && (!type || i.type === type));
    const item = hits.find((i) => !i.system.container) ?? hits[0];
    if (item) return { item, uuid: `Compendium.${s.id}.Item.${item._id}` };
  }
  return undefined;
}

const id = (base) => "bac" + createHash("sha1").update(base).digest("hex").slice(0, 13);
const key = (uuid, name) => (uuid || "name-" + name).replace(/[^a-zA-Z0-9]/g, "-");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const write = (file, doc) => fs.writeFileSync(path.join(OUT, file), JSON.stringify(doc, null, 2) + "\n");

/** a folder of the compendium */
function folder(name, sort, parent = null, sorting = "a") {
  const _id = id("folder" + name);
  write(`folder-${name.replace(/[^a-zA-Z0-9]/g, "")}.json`, {
    _id, _key: `!folders!${_id}`, name, type: "Item", folder: parent, sorting, sort, color: null, description: "", flags: {},
  });
  return _id;
}

/** a result or requirement of a recipe: by uuid when known, the name and type always (they are what is matched) */
function component({ name, type, img, uuid = "", quantity = 1, flags }) {
  const found = uuid ? undefined : find(name, type);
  uuid ||= found?.uuid ?? "";
  const data = {
    id: uuid.split(".").pop() ?? "", uuid, img: img ?? found?.item.img ?? "icons/svg/item-bag.svg",
    name, type: "Item", quantity, itemType: type ?? found?.item.type,
  };
  if (flags) data.flags = flags;
  return { key: key(uuid, name), data };
}
const fromItem = (name, type, flags) => {
  const found = find(name, type);
  if (!found) throw new Error(`missing item ${name} (${type ?? "any type"})`);
  return component({ name, type: found.item.type, img: found.item.img, uuid: found.uuid, flags });
};
const entries = (components) => Object.fromEntries(components.map((c) => [c.key, c.data]));

/** writes a Script item into the pack, returns it as a component; the Scripts folder keeps this order */
let scriptSort = 0;
function script(name, idBase, code, description, img, folderId) {
  const _id = id("script" + idBase);
  scriptSort += 100;
  write(`script-${idBase}.json`, {
    _id, _key: `!items!${_id}`, name, type: "loot", folder: folderId, img, sort: scriptSort,
    system: { description: { value: description } },
    flags: { "beavers-crafting": { subtype: "Script", script: { macro: code } } },
  });
  const uuid = `Compendium.${NS}.${PACK}.Item.${_id}`;
  return { key: key(uuid), data: { id: _id, uuid, img, name, type: "Script", quantity: 1, itemType: "loot" } };
}

/** writes a recipe item into the pack */
function recipe({ idBase, name, img, folderId, craftFolder, required, input, output, instruction }) {
  const _id = id("recipe" + idBase);
  write(`recipe-${idBase}.json`, {
    _id, _key: `!items!${_id}`, name, type: "loot", folder: folderId, img,
    system: { description: { value: instruction } },
    flags: {
      "beavers-crafting": {
        subtype: "Recipe",
        recipe: {
          required: Object.fromEntries(required.map((c, i) => [i + 1, entries([c])])),
          input: Object.fromEntries(input.map((c, i) => [i + 1, entries([c])])),
          output: { 1: entries(output) },
          macro: RESOLVE_MACRO,
          folder: craftFolder,
          instruction,
        },
      },
    },
  });
}

const api = `game.modules.get("${NS}").api`;
// every result: the Dungeon Master's Guide / Player's Handbook item when active, else the SRD, else any item
// with that name and type; none: an error stops the crafting
const RESOLVE_MACRO = `{
  async resultChosen(component, preview) {
    await ${api}.resolve(component, preview);
  }
}`;

const TINKERS_TOOLS = fromItem("Tinker's Tools", "tool");
const SCRIPT_IMG = "icons/magic/symbols/cog-glowing-green.webp";

const FOLDER_TINKER = folder("Tinker's Magic", 100000);
// its plan folders by level (2, 6, 10, 14), not by name
const FOLDER_REPLICATE = folder("Replicate Magic Item", 200000, null, "m");
const FOLDER_SCRIPTS = folder("Scripts", 300000, null, "m");

/* ---------------- Tinker's Magic (Artificer level 1) ---------------- */
const TINKERS_MAGIC_IMG = "icons/tools/hand/wrench-mechanical-heal-blue.webp";
const TINKERS_MAGIC = [
  "Ball Bearings", "Basket", "Bedroll", "Bell", "Blanket", "Block and Tackle", "Bottle, Glass", "Bucket", "Caltrops",
  "Candle", "Crowbar", "Flask", "Grappling Hook", "Hunting Trap", "Jug", "Lamp", "Manacles", "Net", "Oil", "Paper",
  "Parchment", "Pole", "Pouch", "Rope", "Sack", "Shovel", "Spikes, Iron", "String", "Tinderbox", "Torch", "Vial",
];
// do not stack, removed by Beaver's Crafting after the next long rest
const FAST_FLAGS = { "beavers-crafting": { noStack: true, fastCrafted: true } };
/** ammunition is sold as a bundle, everything else as one piece */
const bundle = (name) => {
  const item = find(name)?.item;
  return item?.system.type?.value === "ammo" ? item.system.quantity || 1 : 1;
};

const TINKERS_MAGIC_USE = script(
  "Tinker's Magic use",
  "tinkersmagic",
  `{
  check(quantity) {
    return ${api}.tinkersMagic.check(actor, quantity);
  },
  pay(quantity) {
    return ${api}.tinkersMagic.pay(actor, quantity);
  },
  refund(quantity) {
    return ${api}.tinkersMagic.refund(actor, quantity);
  }
}`,
  `<p>Cost: uses of the feature Tinker's Magic.</p>
<ul>
<li>When the feature has uses set up, those are used.</li>
<li>Otherwise this module counts them: Intelligence modifier (at least 1), all back after a long rest.</li>
</ul>`,
  TINKERS_MAGIC_IMG,
  FOLDER_SCRIPTS,
);

recipe({
  idBase: "tinkersmagic",
  name: "Tinker's Magic",
  img: TINKERS_MAGIC_IMG,
  folderId: FOLDER_TINKER,
  craftFolder: "Artificer",
  required: [TINKERS_TOOLS],
  input: [TINKERS_MAGIC_USE],
  output: TINKERS_MAGIC.map((name) => {
    const c = fromItem(name, undefined, FAST_FLAGS);
    c.data.quantity = bundle(name);
    return c;
  }),
  instruction: `<p>For the Tinker's Magic feature (D&amp;D 2024 Artificer).</p>
<ul>
<li>Requires Tinker's Tools.</li>
<li>Costs one use of Tinker's Magic (see the Script "Tinker's Magic use").</li>
<li>The results do not stack and are removed after the next long rest.</li>
</ul>`,
});
console.log(`Tinker's Magic: ${TINKERS_MAGIC.length} results`);

/* ---------------- Replicate Magic Item (Artificer level 2) ---------------- */
const REPLICATE_IMG = "icons/magic/symbols/runes-star-pentagon-blue.webp";
const REPLICATE_USE = script(
  "Replicate Magic Item",
  "replicate",
  `{
  check(quantity) {
    return ${api}.replicate.check(actor, recipe, quantity);
  },
  pay(quantity) {
    return ${api}.replicate.pay(actor, recipe, quantity);
  },
  refund(quantity) {
    return ${api}.replicate.refund(actor, recipe, quantity);
  }
}`,
  `<p>Cost: one of the magic items of Replicate Magic Item until the next long rest.</p>
<ul>
<li>As many per long rest as the "Magic Items" column of the Artificer table allows for the Artificer level.</li>
<li>Each item since the last long rest must come from a different plan (recipe).</li>
</ul>`,
  REPLICATE_IMG,
  FOLDER_SCRIPTS,
);
const LEVELS = [2, 6, 10, 14];
const LEVEL_SCRIPT = Object.fromEntries(
  LEVELS.map((level) => [
    level,
    script(
      `Artificer level ${level}`,
      "level" + level,
      `{
  check() {
    return ${api}.replicate.level(actor, ${level});
  }
}`,
      `<p>Requirement: the actor has at least ${level} levels in the class Artificer (identifier "artificer").</p>`,
      "icons/sundries/books/book-worn-blue.webp",
      FOLDER_SCRIPTS,
    ),
  ]),
);

// the appendix items of the Artificer's book are in no free compendium: matched by name and type when crafted
const NOT_IN_A_BOOK = {
  "Manifold Tool": { type: "equipment", img: "icons/tools/hand/wrench-adjustable-toothed.webp" },
  "Repeating Shot": { type: "weapon", img: "icons/weapons/crossbows/crossbow-simple-brown.webp" },
  "Returning Weapon": { type: "weapon", img: "icons/weapons/hammers/hammer-war-spiked.webp" },
  "Boots of the Winding Path": { type: "equipment", img: "icons/equipment/feet/boots-leather-engraved-brown.webp" },
  "Dazzling Weapon": { type: "weapon", img: "icons/weapons/swords/sword-guard-gold-red.webp" },
  "Helm of Awareness": { type: "equipment", img: "icons/equipment/head/helm-barbute-engraved.webp" },
  "Mind Sharpener": { type: "equipment", img: "icons/equipment/head/crown-gold-blue.webp" },
  "Repulsion Shield": { type: "equipment", img: "icons/equipment/shield/heater-steel-boss-red.webp" },
  "Spell-Refueling Ring": { type: "equipment", img: "icons/equipment/finger/ring-band-engraved-scrolls-silver.webp" },
};

const isMundane = (i) => !i.system.rarity && i.system.price?.value > 0;
// mundane base items: the Player's Handbook, else the SRD
const sourceFor = () => (SOURCES[1].items.length ? SOURCES[1] : SOURCES.at(-1));
const mundaneOf = (filter) => {
  // the first source that has such items; then by name, each once
  const items = sourceFor().items.filter((i) => isMundane(i) && !i.system.container && filter(i));
  return [...new Map(items.map((i) => [i.name, i])).values()].sort((a, b) => a.name.localeCompare(b.name));
};
const WEAPONS = () => mundaneOf((i) => i.type === "weapon" && ["simpleM", "martialM", "simpleR", "martialR"].includes(i.system.type?.value));
const ARMOR = () => mundaneOf((i) => i.type === "equipment" && ["light", "medium", "heavy"].includes(i.system.type?.value));

/** plans that enchant a base item: the base item is chosen, the module sets the bonus when it is created */
const ENCHANT = {
  weapon: { dmg: "Weapon, +1, +2, or +3", base: WEAPONS },
  armor: { dmg: "Armor, +1, +2, or +3", base: ARMOR },
  shield: { dmg: "Shield, +1, +2, or +3", kind: "armor", base: () => mundaneOf((i) => i.name === "Shield") },
  warMage: { dmg: "Wand of the War Mage, +1, +2, or +3", base: () => mundaneOf((i) => i.name === "Wand") },
  wraps: { dmg: "Wraps of Unarmed Power", base: null },
};

const cursed = (i) => /curse/i.test(i.system.description?.value ?? "");
const magicOf = (filter) => {
  const items = (dmg.length ? dmg : srd).filter((i) => i.system.rarity && !cursed(i) && filter(i));
  return [...new Map(items.map((i) => [i.name, i])).values()].sort((a, b) => a.name.localeCompare(b.name));
};
const wondrous = (i) => (i.type === "equipment" && i.system.type?.value === "wondrous") || i.type === "container";
/** "you can learn this option multiple times": one recipe, the item is chosen */
const GENERIC = {
  "Common Magic Item": () =>
    magicOf((i) => i.system.rarity === "common" && !["potion", "scroll"].includes(i.system.type?.value)),
  "Uncommon Wondrous Item": () => magicOf((i) => i.system.rarity === "uncommon" && wondrous(i)),
  "Rare Wondrous Item": () => magicOf((i) => i.system.rarity === "rare" && wondrous(i)),
};

const PLANS = {
  2: [
    "Alchemy Jug", "Bag of Holding", "Cap of Water Breathing", "Common Magic Item", "Goggles of Night", "Manifold Tool",
    "Repeating Shot", "Returning Weapon", "Rope of Climbing", "Sending Stones", ["Shield", "shield", 1],
    "Wand of Magic Detection", "Wand of Secrets", ["Wand of the War Mage", "warMage", 1], ["Weapon", "weapon", 1],
    ["Wraps of Unarmed Power", "wraps", 1],
  ],
  6: [
    ["Armor", "armor", 1], "Boots of Elvenkind", "Boots of the Winding Path", "Cloak of Elvenkind",
    "Cloak of the Manta Ray", "Dazzling Weapon", "Eyes of Charming", "Eyes of Minute Seeing", "Gloves of Thievery",
    "Helm of Awareness", "Lantern of Revealing", "Mind Sharpener", "Necklace of Adaptation", "Pipes of Haunting",
    "Repulsion Shield", "Ring of Swimming", "Ring of Water Walking", "Sentinel Shield", "Spell-Refueling Ring",
    "Wand of Magic Missiles", "Wand of Web", "Weapon of Warning",
  ],
  10: [
    "Armor of Resistance", "Dagger of Venom", "Elven Chain", "Ring of Feather Falling", "Ring of Jumping",
    "Ring of Mind Shielding", ["Shield", "shield", 2], "Uncommon Wondrous Item", ["Wand of the War Mage", "warMage", 2],
    ["Weapon", "weapon", 2], ["Wraps of Unarmed Power", "wraps", 2],
  ],
  14: [
    ["Armor", "armor", 2], "Arrow-Catching Shield", "Flame Tongue", "Rare Wondrous Item", "Ring of Free Action",
    "Ring of Protection", "Ring of the Ram",
  ],
};

function planInstruction(level, lines) {
  return `<p>A plan of Replicate Magic Item (D&amp;D 2024 Artificer, level ${level}+).</p>
<ul>
<li>Learn the plan: put this recipe on the Artificer. Removing it from the actor makes its items vanish.</li>
<li>Requires Tinker's Tools and Artificer level ${level}.</li>
<li>Costs one item of Replicate Magic Item until the next long rest (see the Script "Replicate Magic Item").</li>
<li>More items than the Artificer level allows: the oldest one vanishes.</li>
${lines.map((l) => `<li>${l}</li>`).join("\n")}
</ul>`;
}

let count = 0;
for (const level of LEVELS) {
  const folderId = folder(`Plans (Level ${level}+)`, level * 1000, FOLDER_REPLICATE);
  for (const plan of PLANS[level]) {
    const [baseName, kind, bonus] = Array.isArray(plan) ? plan : [plan];
    const name = kind ? `${baseName}, +${bonus}` : baseName;
    const recipeName = `Plan: ${name}`;
    const flags = (extra = {}) => ({
      "beavers-crafting": { noStack: true },
      // plan: the recipe's name, its items vanish when the recipe is removed from the actor
      [NS]: { replicated: true, plan: recipeName, ...extra },
    });
    let output;
    let img;
    const lines = [];
    if (kind) {
      const e = ENCHANT[kind];
      img = find(e.dmg)?.item.img ?? REPLICATE_IMG;
      const enchant = { kind: e.kind ?? kind, bonus };
      if (e.base) {
        output = e.base().map((i) => fromItem(i.name, i.type, flags({ enchant })));
        lines.push(`Choose the base item; it gets +${bonus} when it is created.`);
      } else {
        output = [component({ ...(find(e.dmg) ? { uuid: find(e.dmg).uuid, img: find(e.dmg).item.img, type: find(e.dmg).item.type } : { type: "equipment" }), name: e.dmg, flags: flags({ enchant }) })];
        lines.push(`Use the enchantment of the item on your Unarmed Strike (+${bonus}).`);
      }
    } else if (GENERIC[name]) {
      const items = GENERIC[name]();
      output = items.map((i) => fromItem(i.name, i.type, flags()));
      img = REPLICATE_IMG;
      lines.push("You can learn this plan several times, a different item each time: copy the recipe and keep one result.");
    } else if (NOT_IN_A_BOOK[name]) {
      const missing = NOT_IN_A_BOOK[name];
      output = [component({ name, type: missing.type, img: missing.img, flags: flags() })];
      img = missing.img;
      lines.push(`Not in the SRD 5.2 nor the Dungeon Master's Guide: needs an item named "${name}" (${missing.type}) in a compendium or the world.`);
    } else {
      const found = find(name);
      if (!found) throw new Error(`plan ${name}: item not found`);
      output = [fromItem(name, found.item.type, flags())];
      img = found.item.img;
    }
    recipe({
      idBase: `plan-${level}-${name}`,
      name: recipeName,
      img,
      folderId,
      craftFolder: `Artificer.Plans (Level ${level}+)`,
      required: [TINKERS_TOOLS, LEVEL_SCRIPT[level]],
      input: [REPLICATE_USE],
      output,
      instruction: planInstruction(level, lines),
    });
    count++;
  }
}
console.log(`Replicate Magic Item: ${count} plans -> ${OUT}`);
