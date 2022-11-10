import base64url from "base64url";
import { DB_FILTER_ID, DB_USER_ID } from "./db";

export const API_USER_CODE = "usercode";
export const API_FILTER_JSON = "filter";
export const API_PREVIOUS_FILTER_JSON = "prev-filter";
export const API_FILTER_ID = DB_FILTER_ID;
export const API_SUBSCRIPTION = "subscription";

export const API_RESPONSE_FILTER_LIST = "filters";
/** The maximum number of subscribed devices/browsers a user can have. */
export const API_MAX_SUBSCRIPTIONS = 5;

// TODO: Get complete list of gear from Splatoon Wiki.
export enum GEAR_PROPERTY {
	TYPE = "type",
	ABILITY = "ability",
	BRAND = "brand",
	RARITY = "rarity",
	NAME = "name",
}
export const GEAR_EXPIRATION = "expiration";
export const GEAR_PRICE = "price";
export const GEAR_NAMES = ["Fresh Fish Head", "Annaki Flannel Hoodie"];
export const GEAR_TYPES = ["HeadGear", "ClothingGear", "ShoesGear"];

// GrizzCo, Cuttlegear, and Amiibo brands removed.
export const GEAR_BRANDS = [
	"Annaki",
	"Barazushi",
	"Emberz",
	"Enperry",
	"Firefin",
	"Forge",
	"Inkline",
	"Krak-On",
	"Rockenberg",
	"Skalop",
	"Splash Mob",
	"SquidForce",
	"Takoroka",
	"Tentatek",
	"Toni Kensa",
	"Zekko",
	"Zink",
];
export const GEAR_RARITY_MAX = 2;
export const GEAR_RARITY_MIN = 0;

// Ability Doubler removed.
export const GEAR_ABILITIES = [
	"Ink Saver (Main)",
	"Ink Saver (Sub)",
	"Ink Recovery Up",
	"Run Speed Up",
	"Swim Speed Up",
	"Special Charge Up",
	"Special Saver",
	"Special Power Up",
	"Quick Respawn",
	"Quick Super Jump",
	"Sub Power Up",
	"Ink Resistance Up",
	"Sub Resistance Up",
	"Intensify Action",
	"Opening Gambit",
	"Last-Ditch Effort",
	"Tenacity",
	"Comeback",
	"Ninja Squid",
	"Haunt",
	"Thermal Ink",
	"Respawn Punisher",
	"Stealth Jump",
	"Object Shredder",
	"Drop Roller",
];

export const FE_WILDCARD = "Any";
export const FE_COOKIE_USER_ID = DB_USER_ID;

// TODO: Use environmental variables in production environment; move this and
// other example development keys to their own file. OK *ONLY* for testing. 
// Generate using `npx web-push generate-vapid-keys --json`.
export const VAPID_PUBLIC_KEY = "BP0f7Rhdh5eQg3mWuu7SyUptJ-MGm6f9Ci4ldL1yp4BWK_651XEiBJrDrOmTGqme8ndpETkkdqAbu-_zxCiNoyk";
export const VAPID_PRIVATE_KEY = "kKRbyxQeGeeoEtRCij10GRZUa4DoF8FXEMK1Sxf5ChM";
