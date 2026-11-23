// Beaver's Artificer's Crafting (dnd5e, D&D 2024 Artificer)
// - Tinker's Magic: its uses (the feature's own uses, or a counter of this module)
// - Replicate Magic Item: plans are recipes on the actor; items per long rest, maximum held, oldest vanishes,
//   items of a removed plan vanish
// - every result is looked up when it is crafted: Dungeon Master's Guide / Player's Handbook, then the SRD,
//   then any compendium or world item with the same name and type
// The Scripts of the compendium call game.modules.get("beavers-artificers-crafting").api.

const MODULE = "beavers-artificers-crafting";
const CRAFTING = "beavers-crafting";
const REST_FLAG = "rest"; // { tinkersMagic: number, replicated: number, plans: string[] } since the last long rest

const i18n = (key, data) =>
  data ? game.i18n.format(`beaversArtificersCrafting.${key}`, data) : game.i18n.localize(`beaversArtificersCrafting.${key}`);

/* ---------------------------------------------------------------- */
/*  Artificer                                                         */
/* ---------------------------------------------------------------- */

/** Artificer level: the class with identifier "artificer" (or named Artificer) */
function artificerLevel(actor) {
  const cls =
    actor.classes?.artificer ?? actor.items.find((i) => i.type === "class" && i.name.toLowerCase() === "artificer");
  return cls?.system.levels ?? 0;
}

/** the "Magic Items" column: how many replicated items you can have (and create per long rest) */
function magicItemsMax(level) {
  if (level < 2) return 0;
  if (level < 6) return 2;
  if (level < 10) return 3;
  if (level < 14) return 4;
  if (level < 18) return 5;
  return 6;
}

const restState = (actor) => ({ tinkersMagic: 0, replicated: 0, plans: [], ...(actor.getFlag(MODULE, REST_FLAG) ?? {}) });
const setRestState = (actor, state) => actor.setFlag(MODULE, REST_FLAG, state);

/* ---------------------------------------------------------------- */
/*  Tinker's Magic                                                    */
/* ---------------------------------------------------------------- */

/** the actor's Tinker's Magic feature, by its identifier or its name (it is not in the SRD) */
function tinkersMagicFeature(actor) {
  return actor.items.find(
    (i) => i.type === "feat" && (i.system.identifier === "tinkers-magic" || i.name === "Tinker's Magic"),
  );
}

/**
 * Where the uses are counted:
 * - the feature has uses (max set up): the feature's own uses, dnd5e gives them back on a rest
 * - otherwise this module: Intelligence modifier (at least 1), all back after a long rest
 */
function tinkersMagicUses(actor) {
  const item = tinkersMagicFeature(actor);
  if (!item) return undefined;
  if (item.system.uses?.max) {
    return {
      left: item.system.uses.value ?? 0,
      spend: (quantity) => item.update({ "system.uses.spent": Math.max(0, (item.system.uses.spent ?? 0) + quantity) }),
    };
  }
  const max = Math.max(1, actor.system.abilities?.int?.mod ?? 0);
  const state = restState(actor);
  return {
    left: Math.max(0, max - state.tinkersMagic),
    spend: (quantity) => setRestState(actor, { ...state, tinkersMagic: Math.max(0, state.tinkersMagic + quantity) }),
  };
}

const tinkersMagic = {
  check(actor, quantity = 1) {
    const uses = tinkersMagicUses(actor);
    if (!uses) return i18n("tinkersMagic.missing");
    return uses.left >= quantity || i18n("tinkersMagic.noUses", { quantity });
  },
  pay(actor, quantity = 1) {
    return tinkersMagicUses(actor)?.spend(quantity);
  },
  refund(actor, quantity = 1) {
    return tinkersMagicUses(actor)?.spend(-quantity);
  },
};

/* ---------------------------------------------------------------- */
/*  Replicate Magic Item                                              */
/* ---------------------------------------------------------------- */

/** the plan of a recipe: every crafted item of a plan carries it, each long rest a plan can be used once */
const planOf = (recipe) => recipe?.name ?? "";

const replicate = {
  /** required Script "Artificer level N" */
  level(actor, level) {
    return artificerLevel(actor) >= level || i18n("replicate.level", { level });
  },
  /** cost Script "Replicate Magic Item": items per long rest, each from a different plan */
  check(actor, recipe, quantity = 1) {
    const max = magicItemsMax(artificerLevel(actor));
    if (!max) return i18n("replicate.level", { level: 2 });
    const state = restState(actor);
    if (state.plans.includes(planOf(recipe))) return i18n("replicate.samePlan");
    return state.replicated + quantity <= max || i18n("replicate.noneLeft", { max });
  },
  pay(actor, recipe, quantity = 1) {
    const state = restState(actor);
    return setRestState(actor, {
      ...state,
      replicated: state.replicated + quantity,
      plans: [...new Set([...state.plans, planOf(recipe)])],
    });
  },
  refund(actor, recipe, quantity = 1) {
    const state = restState(actor);
    return setRestState(actor, {
      ...state,
      replicated: Math.max(0, state.replicated - quantity),
      plans: state.plans.filter((p) => p !== planOf(recipe)),
    });
  },
};

/** a replicated item gets its creation time; enchantment plans (+1 weapon …) are applied to the base item */
function prepareReplicated(item, data) {
  const flags = data.flags?.[MODULE];
  if (!flags?.replicated) return;
  const changes = { [`flags.${MODULE}.createdAt`]: Date.now() };
  const enchant = flags.enchant;
  if (enchant) {
    const bonus = Number(enchant.bonus) || 1;
    const rarity = { 1: "uncommon", 2: "rare", 3: "veryRare" }[bonus];
    const properties = new Set(data.system?.properties ?? []);
    properties.add("mgc");
    changes["system.properties"] = [...properties];
    if (enchant.kind === "weapon") {
      changes.name = `${data.name} +${bonus}`;
      changes["system.magicalBonus"] = bonus;
      changes["system.rarity"] = rarity;
    } else if (enchant.kind === "armor") {
      changes.name = `${data.name} +${bonus}`;
      changes["system.armor.magicalBonus"] = bonus;
      // armor is one step rarer than weapons and shields
      changes["system.rarity"] = data.system?.type?.value === "shield" ? rarity : { 1: "rare", 2: "veryRare", 3: "legendary" }[bonus];
    } else if (enchant.kind === "warMage") {
      changes.name = `${data.name} of the War Mage, +${bonus}`;
      changes["system.rarity"] = rarity;
      changes["system.attunement"] = "required";
      changes.effects = [
        ...(data.effects ?? []),
        {
          name: `War Mage +${bonus}`,
          img: data.img,
          transfer: true,
          changes: ["msak", "rsak"].map((k) => ({ key: `system.bonuses.${k}.attack`, value: `${bonus}`, type: "add", mode: 2 })),
        },
      ];
    } else if (enchant.kind === "wraps") {
      // the wraps enchant the Unarmed Strike with their own activity: only name and rarity here
      changes.name = `${data.name}, +${bonus}`;
      changes["system.rarity"] = rarity;
    }
  }
  // attune the moment it is created
  if ((foundry.utils.getProperty(changes, "system.attunement") ?? data.system?.attunement) === "required") {
    changes["system.attuned"] = true;
  }
  item.updateSource(changes);
}

/** you can't have more replicated items than the "Magic Items" column: the oldest vanishes */
async function enforceMaximum(actor) {
  const max = magicItemsMax(artificerLevel(actor));
  const items = actor.items
    .filter((i) => i.getFlag(MODULE, "replicated"))
    .sort((a, b) => (a.getFlag(MODULE, "createdAt") ?? 0) - (b.getFlag(MODULE, "createdAt") ?? 0));
  const vanish = items.slice(0, Math.max(0, items.length - max));
  await vanishItems(actor, vanish, "replicate.oldestVanished");
}

/** an actor's recipe (plan) is removed: the items made with it vanish */
async function removePlan(recipeItem) {
  const actor = recipeItem.parent;
  if (!(actor instanceof Actor)) return;
  if (recipeItem.getFlag(CRAFTING, "subtype") !== "Recipe") return;
  const plan = recipeItem.name;
  const vanish = actor.items.filter((i) => i.getFlag(MODULE, "replicated") && i.getFlag(MODULE, "plan") === plan);
  await vanishItems(actor, vanish, "replicate.planVanished");
}

async function vanishItems(actor, items, messageKey) {
  if (!items.length) return;
  await actor.deleteEmbeddedDocuments("Item", items.map((i) => i.id));
  const names = items.map((i) => foundry.utils.escapeHTML(i.name)).join(", ");
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p>${i18n(messageKey, { items: names })}</p>`,
  });
}

/* ---------------------------------------------------------------- */
/*  Finding the item of a result                                      */
/* ---------------------------------------------------------------- */

// the books win over the SRD; each of them only when its module is active
const BOOK_PACKS = ["dnd-dungeon-masters-guide.equipment", "dnd-players-handbook.equipment"];
const SRD_PACKS = ["dnd5e.equipment24"];

const norm = (s) => String(s ?? "").trim().toLowerCase();

async function findInPack(packId, name, type) {
  const pack = game.packs.get(packId);
  if (!pack || pack.documentName !== "Item") return undefined;
  const index = await pack.getIndex({ fields: ["type", "img"] });
  const entry = index.find((e) => norm(e.name) === norm(name) && (!type || e.type === type));
  return entry ? { uuid: entry.uuid ?? `Compendium.${packId}.Item.${entry._id}`, img: entry.img } : undefined;
}

/**
 * The item a result is made from, by name and item type:
 * Dungeon Master's Guide / Player's Handbook (when active), the SRD, any other Item compendium, the world's items.
 */
async function findItem(name, type) {
  for (const packId of [...BOOK_PACKS, ...SRD_PACKS]) {
    const found = await findInPack(packId, name, type);
    if (found) return found;
  }
  const known = new Set([...BOOK_PACKS, ...SRD_PACKS]);
  for (const pack of game.packs.filter((p) => p.documentName === "Item" && !known.has(p.collection))) {
    const found = await findInPack(pack.collection, name, type);
    if (found) return found;
  }
  const item = game.items.find((i) => norm(i.name) === norm(name) && (!type || i.type === type));
  return item ? { uuid: item.uuid, img: item.img } : undefined;
}

/** recipe macro "resultChosen": points the result at the item found; none found: an error stops the crafting */
async function resolve(component, preview) {
  const found = await findItem(component.name, component.itemType);
  if (!found) {
    const message = i18n("missingItem", { name: component.name, type: component.itemType ?? "" });
    if (!preview) ui.notifications.error(message, { permanent: true });
    throw new Error(message);
  }
  component.uuid = found.uuid;
  if (found.img) component.img = found.img;
}

/* ---------------------------------------------------------------- */

Hooks.once("init", () => {
  game.modules.get(MODULE).api = { tinkersMagic, replicate, resolve, findItem, artificerLevel, magicItemsMax };
});

Hooks.on("preCreateItem", (item, data) => {
  if (item.parent instanceof Actor) prepareReplicated(item, data);
});

Hooks.on("createItem", async (item, options, userId) => {
  if (userId !== game.user.id || !(item.parent instanceof Actor) || !item.getFlag(MODULE, "replicated")) return;
  await enforceMaximum(item.parent);
});

Hooks.on("deleteItem", async (item, options, userId) => {
  if (userId !== game.user.id) return;
  await removePlan(item);
});

// a long rest gives back the uses of Tinker's Magic (own counter) and the items of Replicate Magic Item
Hooks.on("dnd5e.restCompleted", async (actor, result) => {
  if (!result?.longRest || !actor?.isOwner || !actor.getFlag(MODULE, REST_FLAG)) return;
  await actor.unsetFlag(MODULE, REST_FLAG);
});
