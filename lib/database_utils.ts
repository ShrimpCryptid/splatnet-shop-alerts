import { Pool, PoolClient, QueryResult } from "pg";
import { Gear } from "./gear";
import { GEAR_BRANDS, GEAR_TYPES, GEAR_ABILITIES } from "../constants";
import {
	DB_GEAR_NAME,
	DB_GEAR_RARITY,
	DB_GEAR_TYPE_WILDCARD,
	DB_GEAR_ABILITY_WILDCARD,
	DB_GEAR_BRAND_WILDCARD,
	DB_TABLE_FILTERS,
	DB_FILTER_ID,
	DB_LAST_NOTIFIED_EXPIRATION,
	DB_PAIR_ID,
	DB_TABLE_USERS,
	DB_TABLE_USERS_TO_FILTERS,
	DB_USER_ID,
	DB_USER_CODE,
	DB_LAST_MODIFIED,
	DB_TABLE_SUBSCRIPTIONS,
	DB_ENDPOINT,
	DB_EXPIRATION,
	DB_AUTH_KEY,
	DB_P256DH_KEY,
	DB_SUBSCRIPTION_ID,
	DB_TABLE_SERVER_CACHE,
	DB_CACHE_DATA,
	DB_CACHE_KEY,
	DB_NICKNAME,
} from "../constants/db";
import Filter from "./filter";
import {
	NotYetImplementedError,
	NoSuchUserError,
	NoSuchFilterError,
	mapGetWithDefault,
	IllegalArgumentError,
	getEnvWithDefault,
	isValidUserCode,
	generateRandomUserCode,
	isValidNickname,
} from "./shared_utils";
import { Subscription } from "./notifications";
import webpush from "web-push";
import { configureWebPush } from "./backend_utils";
import {
	ENV_KEY_PGDATABASE,
	ENV_KEY_PGHOST,
	ENV_KEY_PGPASSWORD,
	ENV_KEY_PGPORT,
	ENV_KEY_PGSTRING,
	ENV_KEY_PGUSER,
} from "../constants/env";

// ==============
// HELPER METHODS
// ==============
// #region

/**Removes whitespace and other SQL-sensitive characters from column names.*/
function formatCol(input: string): string {
	return input.replace(/\(| |\)|-/g, "").toLowerCase(); // Remove (, ), whitespace, and - characters.
}

function arrayEqual(arr1: any[], arr2: any[]): boolean {
	if (arr1.length === arr2.length) {
		for (let i = 0; i < arr1.length; i++) {
			if (arr1[i] !== arr2[i]) {
				return false;
			}
		}
		return true;
	}
	return false;
}

/**
 * Queries the client and logs any errors to the console, along with the
 * offending SQL query.
 * @param client
 * @param queryText The text string of the query. Queries can be parameterized
 * as described in the node-postgres documentation
 * (https://node-postgres.com/features/queries) to prevent SQL injection.
 * @param values Optional array of parameters to pass along with the text
 *  query.
 * @throws any errors generated by the query operation.
 * @returns The result of the query, if it returned successfully.
 */
async function queryAndLog(
	client: Pool | PoolClient,
	queryText: string,
	values: any[] = []
): Promise<QueryResult> {
	try {
		const result = await client.query(queryText, values);
		return result;
	} catch (err) {
		console.log("ENCOUNTERED ERROR:");
		console.log(queryText);
		console.log(values);
		throw err;
	}
}

/**
 * @returns the given filter represented as a dictionary, where keys are column names for
 * storage in a database table with their corresponding values.
 * Can be iterated over to generate SQL queries.
 */
function filterToTableData(filter: Filter): { [id: string]: any } {
	let data: { [key: string]: any } = {
		[DB_GEAR_NAME]: `'${filter.gearName}'`,
		[DB_GEAR_RARITY]: filter.minimumRarity,
		[DB_GEAR_TYPE_WILDCARD]: arrayEqual(filter.gearTypes, []),
		[DB_GEAR_ABILITY_WILDCARD]: arrayEqual(filter.gearAbilities, []),
		[DB_GEAR_BRAND_WILDCARD]: arrayEqual(filter.gearBrands, []),
	};

	for (var ability of GEAR_ABILITIES) {
		data[formatCol(ability)] = filter.gearAbilities.includes(ability);
	}
	for (var brand of GEAR_BRANDS) {
		data[formatCol(brand)] = filter.gearBrands.includes(brand);
	}
	for (var type of GEAR_TYPES) {
		data[formatCol(type)] = filter.gearTypes.includes(type);
	}
	return data;
}

/**
 * Makes a mapping from the formatted column names to their unformatted counterparts.
 */
function mapFromColumnName(unformattedColumns: string[]): Map<string, string> {
	let map = new Map<string, string>();
	for (var col of unformattedColumns) {
		map.set(formatCol(col), col);
	}
	return map;
}

function rowDataToFilter(rowData: { [key: string]: any }): Filter {
	let types: string[] = [];
	let abilities: string[] = [];
	let brands: string[] = [];
	let rarity = rowData[DB_GEAR_RARITY];
	let name = rowData[DB_GEAR_NAME];

	// The property names of columns have been formatted-- for example, 'Last-Ditch Effort' becomes
	// 'lastditcheffort'. However, they need to be stored in the filter properties as unconverted
	// names, so we make a mapping from their converted to their unconverted names. This also
	// lets us programmatically get all the filter data for gear types, abilities, and brands.
	if (!rowData[DB_GEAR_TYPE_WILDCARD]) {
		let typesMap = mapFromColumnName(GEAR_TYPES);
		for (var type of typesMap.keys()) {
			if (rowData[type]) {
				types.push(mapGetWithDefault(typesMap, type, ""));
			}
		}
	}
	if (!rowData[DB_GEAR_ABILITY_WILDCARD]) {
		let abilitiesMap = mapFromColumnName(GEAR_ABILITIES);
		for (var ability of abilitiesMap.keys()) {
			if (rowData[ability]) {
				abilities.push(mapGetWithDefault(abilitiesMap, ability, ""));
			}
		}
	}
	if (!rowData[DB_GEAR_BRAND_WILDCARD]) {
		let brandsMap = mapFromColumnName(GEAR_BRANDS);
		for (var brand of brandsMap.keys()) {
			if (rowData[brand]) {
				brands.push(mapGetWithDefault(brandsMap, brand, ""));
			}
		}
	}

	return new Filter(name, rarity, types, brands, abilities);
}

/** Returns the current time as a timestamp, wrapped in quotes for inserting
 * into an SQL query.
 */
function getTimestamp(): string {
	return `'${new Date(Date.now()).toISOString()}'`;
}

//#endregion HELPER METHODS

// ==============
// DATABASE SETUP
// ==============
// #region

/**
 * @effects Initial setup the database and its tables.
 */
export function setupDatabaseTables() {
	// Create data cache table
	// Note-- Gear JSON usually around 10-12k characters, so limit is 16000 chars.
	let promises = [];
	let client = getDBClient();

	promises.push(
		queryAndLog(
			client,
			`CREATE TABLE IF NOT EXISTS ${DB_TABLE_SERVER_CACHE} (
      ${DB_CACHE_KEY} varchar(255),
      ${DB_CACHE_DATA} jsonb,
      ${DB_LAST_MODIFIED} varchar(30),
      PRIMARY KEY (${DB_CACHE_KEY})
    );`
		)
	);

	// Create users table
	promises.push(
		queryAndLog(
			client,
			`CREATE TABLE IF NOT EXISTS ${DB_TABLE_USERS} (
            ${DB_USER_ID} SERIAL UNIQUE,
            ${DB_USER_CODE} varchar(255) UNIQUE,
            ${DB_NICKNAME} varchar(60),
            ${DB_LAST_NOTIFIED_EXPIRATION} varchar(30),
            ${DB_LAST_MODIFIED} varchar(30),
            PRIMARY KEY (${DB_USER_ID})
        );`
		)
	);

	// Create user subscriptions table.
	promises.push(
		queryAndLog(
			client,
			`CREATE TABLE IF NOT EXISTS ${DB_TABLE_SUBSCRIPTIONS} (
          ${DB_SUBSCRIPTION_ID} SERIAL UNIQUE,
          ${DB_USER_ID} int4,
          ${DB_ENDPOINT} varchar(400),
          ${DB_EXPIRATION} varchar(255),
          ${DB_AUTH_KEY} varchar(255),
          ${DB_P256DH_KEY} varchar(255),
          ${DB_LAST_MODIFIED} varchar(30),
          PRIMARY KEY (${DB_SUBSCRIPTION_ID}),
          CONSTRAINT fk_userid
            FOREIGN KEY (${DB_USER_ID})
              REFERENCES ${DB_TABLE_USERS}(${DB_USER_ID})
    );`
		)
	);

	// Auto-generate filter table.
	// Auto-generates boolean columns for gear types, abilities, and brands.
	let joinedFilterColumnNames =
		GEAR_TYPES.concat(GEAR_ABILITIES).concat(GEAR_BRANDS);
	for (let i = 0; i < joinedFilterColumnNames.length; i++) {
		joinedFilterColumnNames[i] = formatCol(joinedFilterColumnNames[i]);
	}
	let filterColumnQuery = joinedFilterColumnNames.join(" BOOL,\n\t") + " BOOL";

	promises.push(
		queryAndLog(
			client,
			`CREATE TABLE IF NOT EXISTS ${DB_TABLE_FILTERS} (
        ${DB_FILTER_ID} SERIAL UNIQUE,
        ${DB_GEAR_NAME} varchar(255),
        ${DB_GEAR_RARITY} int2,
        ${DB_GEAR_TYPE_WILDCARD} BOOL,
        ${DB_GEAR_BRAND_WILDCARD} BOOL,
        ${DB_GEAR_ABILITY_WILDCARD} BOOL,
        ${filterColumnQuery}
    );`
		)
	);

	// Create pairing table, which pairs users with their selected filters.
	promises.push(
		queryAndLog(
			client,
			`
    CREATE TABLE IF NOT EXISTS ${DB_TABLE_USERS_TO_FILTERS} (
        ${DB_PAIR_ID} SERIAL UNIQUE,
        ${DB_USER_ID} int4,
        ${DB_FILTER_ID} int4,
        ${DB_LAST_MODIFIED} varchar(30),
        PRIMARY KEY (${DB_PAIR_ID}),
        CONSTRAINT fk_userid
          FOREIGN KEY (${DB_USER_ID})
            REFERENCES ${DB_TABLE_USERS}(${DB_USER_ID}),
        CONSTRAINT fk_filterid
          FOREIGN KEY (${DB_FILTER_ID})
            REFERENCES ${DB_TABLE_FILTERS}(${DB_FILTER_ID})
    );`
		)
	);

	Promise.all(promises); // wait for all queries to complete execution.
}

// #endregion DATABASE SETUP

// ==========
// DATA CACHE
// ==========
// #region

/**
 * Returns whether the database cache containts the given key.
 * NOTE: Does not check for null values!
 */
export async function hasCachedData(
	client: Pool | PoolClient,
	key: string
): Promise<boolean> {
	let result = await queryAndLog(
		client,
		`SELECT FROM ${DB_TABLE_SERVER_CACHE} WHERE ${DB_CACHE_KEY} = $1`,
		[key] // passed as parameter to prevent SQL insertion attack
	);
	return result.rowCount > 0;
}

export async function getCachedData(
	client: Pool | PoolClient,
	key: string,
	defaultValue: any = null
): Promise<any> {
	let result = await queryAndLog(
		client,
		`SELECT ${DB_CACHE_DATA} FROM ${DB_TABLE_SERVER_CACHE}
      WHERE ${DB_CACHE_KEY} = $1`,
		[key]
	);
	if (result.rowCount > 0) {
		return result.rows[0][DB_CACHE_DATA];
	} else {
		return defaultValue;
	}
}

export async function setCachedData(
	client: Pool | PoolClient,
	key: string,
	value: any
) {
	// Insert into the table unless the key already exists, in which case the
	// new values will be inserted instead.
	await queryAndLog(
		client,
		`INSERT INTO ${DB_TABLE_SERVER_CACHE} (${DB_CACHE_KEY}, ${DB_CACHE_DATA}, ${DB_LAST_MODIFIED})
        VALUES ($1, $2, $3)
      ON CONFLICT (${DB_CACHE_KEY}) DO
          UPDATE SET
            ${DB_CACHE_DATA} = $2,
            ${DB_LAST_MODIFIED} = $3;`,
		[key, value, getTimestamp()]
	);
}

// #endregion DATA CACHE

// =============
// FILTER ACCESS
// =============
// #region

/**
 * Searches and returns the ID of the first matching filter.
 * @param filter filter to search for
 * @returns The Filter ID of the first matching filter, if one exists. Otherwise, returns -1.
 */
export async function getMatchingFilterID(
	client: PoolClient | Pool,
	filter: Filter
): Promise<number> {
	// format filter parameters
	let filterData = filterToTableData(filter);
	let queryArgs: string[] = [];
	for (var key in filterData) {
		queryArgs.push(`${key} = ${filterData[key]}`); // 'key = value'
	}

	// parse arguments into a SQL query
	// syntax: SELECT * FROM [TableName]
	// WHERE c1=v1 AND c2=v2 AND c3=v3 AND ...;
	let results = await queryAndLog(
		client,
		`SELECT ${DB_FILTER_ID} FROM ${DB_TABLE_FILTERS} 
     WHERE ${queryArgs.join(" AND ")};`
	);

	if (results) {
		if (results.rowCount > 0) {
			return results.rows[0][DB_FILTER_ID]; // get first matching filter ID
		}
	}
	return -1;
}

/** Returns whether this filter ID exists in the database. */
async function hasFilterID(
	client: PoolClient | Pool,
	filterID: number
): Promise<boolean> {
	let result = await queryAndLog(
		client,
		`SELECT FROM ${DB_TABLE_FILTERS} WHERE ${DB_FILTER_ID} = ${filterID}`
	);
	// Check where there are any rows in the results.
	return result ? result.rowCount > 0 : false;
}

/**
 * Attempts to add a given filter to the table, if it does not already exist.
 * @return {number} Returns the ID of newly created filter, or a matching existing filter.
 */
export async function tryAddFilter(
	client: PoolClient | Pool,
	filter: Filter
): Promise<number> {
	let filterID = await getMatchingFilterID(client, filter);

	if (filterID === -1) {
		let filterData = filterToTableData(filter);

		// INSERT INTO [table_name] ([col1], [col2], ...) VALUES ([val1], [val2], ...)
		// RETURNING clause gets the specified columns of any created/modified rows.
		let result = await client.query(`
            INSERT INTO ${DB_TABLE_FILTERS} (${Object.keys(filterData).join(
			", "
		)})
            VALUES (${Object.values(filterData).join(
							", "
						)}) RETURNING ${DB_FILTER_ID};`);
		filterID = result.rows[0][DB_FILTER_ID];
	}
	// Return new filter ID
	return filterID;
}

/**
 * Attempts to remove a filter specified by its id.
 * @param {number} filterID
 * @return {boolean} whether the operation was successfully completed.
 */
async function removeFilter(
	client: PoolClient | Pool,
	filterID: number
): Promise<boolean> {
	// TODO: Only allow deletion if the filter has no paired users?
	// Note: can use returning to get deleted rows
	let result = await client.query(`
        DELETE FROM ${DB_TABLE_FILTERS}
        WHERE ${DB_FILTER_ID}=${filterID} RETURNING *;`);

	// TODO: Change return type based on result?
	return false;
}

// #endregion FILTER ACCESS

// ===========
// USER ACCESS
// ===========
// #region

export async function makeNewUser(client: PoolClient | Pool): Promise<string> {
	let newUserCode = await generateUnusedUserCode(client);
	// TODO: add creation timestamp
	let result = await queryAndLog(
		client,
		`INSERT INTO ${DB_TABLE_USERS}
      (${DB_USER_CODE}, ${DB_LAST_MODIFIED})
      VALUES ($1, ${getTimestamp()});`,
		[newUserCode]
	);
	return newUserCode;
}

async function generateUnusedUserCode(
	client: PoolClient | Pool
): Promise<string> {
	// generate number
	let userCode = "";
	// repeat until there is no user with this existing user code.
	do {
		userCode = generateRandomUserCode();
	} while ((await getUserIDFromCode(client, userCode)) !== -1);
	return userCode;
}

/** Stores a new PushSubscription associated with a user. */
export async function addUserPushSubscription(
	client: PoolClient | Pool,
	userID: number,
	subscription: Subscription
) {
	// Note-- all `subscription` fields are vulnerable to SQL injection. Therefore
	// all of these fields MUST be passed as parameters to client.query() or
	// queryAndLog() (see optional value parameter).
	if (!(await hasUser(client, userID))) {
		throw new NoSuchUserError(userID);
	}
	// Check if user has already subscribed this device
	// use text, value query style to prevent SQL injection attacks
	let result = await queryAndLog(
		client,
		`SELECT ${DB_SUBSCRIPTION_ID} FROM ${DB_TABLE_SUBSCRIPTIONS}
      WHERE ${DB_USER_ID} = ${userID}
        AND ${DB_ENDPOINT} = $1;`,
		[subscription.endpoint]
	);

	// Check whether we need to update the entry or make a new one.
	if (result.rowCount > 0) {
		// Already has this entry, so we update it
		let subscriptionID = result.rows[0][DB_SUBSCRIPTION_ID];
		await queryAndLog(
			client,
			`UPDATE ${DB_TABLE_SUBSCRIPTIONS}
        SET ${DB_ENDPOINT} = $1,
            ${DB_EXPIRATION} = $2,
            ${DB_AUTH_KEY} = $3,
            ${DB_P256DH_KEY} = $4,
            ${DB_LAST_MODIFIED} = $5
        WHERE ${DB_SUBSCRIPTION_ID} = $6;`,
			[
				subscription.endpoint,
				subscription.expirationTime,
				subscription.keys.auth,
				subscription.keys.p256dh,
				getTimestamp(),
        subscriptionID
			]
		);
	} else {
		// Create a new entry for new subscription
		await queryAndLog(
			client,
			`INSERT INTO ${DB_TABLE_SUBSCRIPTIONS}
        ( ${DB_USER_ID},
          ${DB_ENDPOINT},
          ${DB_EXPIRATION},
          ${DB_AUTH_KEY},
          ${DB_P256DH_KEY},
          ${DB_LAST_MODIFIED}
        )
        VALUES (${userID}, $1, $2, $3, $4, $5);`,
			[
				subscription.endpoint,
				subscription.expirationTime,
				subscription.keys.auth,
				subscription.keys.p256dh,
				getTimestamp(),
			]
		);
	}
}

async function removeUser(client: PoolClient | Pool, userID: number) {
	// Check if user exists
	// Remove all filters user is subscribed to
	// Remove all subscriptions the user has
	// Finally remove user
	if (!(await hasUser(client, userID))) {
		throw new NoSuchUserError(userID);
	}
	throw new NotYetImplementedError("");
}

async function hasUser(
	client: PoolClient | Pool,
	userID: number
): Promise<boolean> {
	let result = await queryAndLog(
		client,
		`SELECT FROM ${DB_TABLE_USERS} WHERE ${DB_USER_ID} = $1`,
		[userID]
	);
	return result ? result.rowCount > 0 : false;
}

/**
 * Returns the user's internal ID from their public-facing, string user ID code.
 * @param userCode
 * @return the user's internal ID (as an int) if found. Otherwise, returns -1.
 */
export async function getUserIDFromCode(
	client: PoolClient | Pool,
	userCode: string
): Promise<number> {
	if (!isValidUserCode(userCode)) {
		throw new IllegalArgumentError(userCode + " is not a valid uuid.");
	}
	let result = await queryAndLog(
		client,
		`SELECT ${DB_USER_ID} FROM ${DB_TABLE_USERS}
      WHERE ${DB_USER_CODE} = $1`,
		[userCode] // passed as parameter so postgres can handle attack prevention
	);
	if (result.rowCount == 0) {
		return -1;
	} else {
		return result.rows[0][DB_USER_ID];
	}
}

/**
 * Updates the nickname field in the database for the given user ID.
 */
export async function updateUserNickname(
	client: PoolClient | Pool,
	userID: number,
	nickname: string
) {
	if (!isValidNickname) {
		throw new IllegalArgumentError("Nickname '" + nickname + "' is invalid.");
	}
	await queryAndLog(
		client,
		`UPDATE ${DB_TABLE_USERS}
      SET ${DB_NICKNAME} = $1
      WHERE ${DB_USER_ID} = $2`,
		[nickname, userID] // passed via parameter array for sanitization
	);
}

type UserData = {
	usercode: string;
	nickname: string;
	lastModified: Date;
	lastModifiedExpiration: Date;
};

/**
 * Returns an object with the user's data, including their usercode, nickname,
 * and last modified timestamp.
 */
export async function getUserData(
	client: PoolClient | Pool,
	userID: number
): Promise<UserData | null> {
	let result = await queryAndLog(
		client,
		`SELECT * FROM ${DB_TABLE_USERS}
      WHERE ${DB_USER_ID} = $1;`,
		[userID]
	);
	if (result.rowCount > 0) {
		return {
			usercode: result.rows[0][DB_USER_CODE],
			nickname: result.rows[0][DB_NICKNAME],
			lastModified: new Date(result.rows[0][DB_LAST_MODIFIED]),
			lastModifiedExpiration: new Date(
				result.rows[0][DB_LAST_NOTIFIED_EXPIRATION]
			),
		};
	}
	return null;
}

// #endregion USER ACCESS

// ===========================
// USER AND FILTER INTERACTION
// ===========================
// #region

async function doesUserHaveFilter(
	client: PoolClient | Pool,
	userID: number,
	filterID: number
): Promise<boolean> {
	let result = await queryAndLog(
		client,
		`SELECT FROM ${DB_TABLE_USERS_TO_FILTERS}
      WHERE ${DB_FILTER_ID} = ${filterID} AND ${DB_USER_ID} = ${userID};`
	);
	if (result) {
		return result.rowCount > 0;
	} else {
		return false;
	}
}

/**
 * Subscribes the user to the given filter, if they are not already subscribed.
 * @throws {NoSuchFilterError} if the filter does not exist.
 * @throws {NoSuchUserError} if the user does not exist.
 */
export async function addFilterToUser(
	client: PoolClient | Pool,
	userID: number,
	filterID: number
) {
	if (!(await hasUser(client, userID))) {
		throw new NoSuchUserError(userID);
	}
	if (!(await hasFilterID(client, filterID))) {
		throw new NoSuchFilterError(filterID);
	}

	if (!(await doesUserHaveFilter(client, userID, filterID))) {
		// Make the new filter
		await queryAndLog(
			client,
			`INSERT INTO ${DB_TABLE_USERS_TO_FILTERS}
        (${DB_USER_ID}, ${DB_FILTER_ID}, ${DB_LAST_MODIFIED})
        VALUES (${userID}, ${filterID}, ${getTimestamp()});`
		);
	}
}

/**
 * Unsubscribe user from a filter, if they are currently subscribed to it.
 */
export async function removeUserFilter(
	client: PoolClient | Pool,
	userID: number,
	filterID: number
) {
	if (await doesUserHaveFilter(client, userID, filterID)) {
		await queryAndLog(
			client,
			`DELETE FROM ${DB_TABLE_USERS_TO_FILTERS}
            WHERE ${DB_USER_ID} = ${userID} AND ${DB_FILTER_ID} = ${filterID};`
		);
	}
	// TODO: Check if filter should be deleted if no other users reference it?
}

/**
 * Gets a list of all filters the user is subscribed to.
 * @throws {NoSuchUserError} is the user does not exist.
 */
export async function getUserFilters(
	client: PoolClient | Pool,
	userID: number
): Promise<Filter[]> {
	// TODO: Sort list by edited timestamp
	if (!(await hasUser(client, userID))) {
		throw new NoSuchUserError(userID);
	}
	// Get all filter IDs the user is subscribed to
	let results = await queryAndLog(
		client,
		// userFilters is a temporary table used to index into the Filters table
		`WITH userFilters(${DB_FILTER_ID}) AS 
        (SELECT ${DB_FILTER_ID} FROM ${DB_TABLE_USERS_TO_FILTERS}
        WHERE ${DB_USER_ID} = ${userID})
      SELECT * FROM ${DB_TABLE_FILTERS}, userFilters
      WHERE ${DB_TABLE_FILTERS}.${DB_FILTER_ID} = userFilters.${DB_FILTER_ID}`
	);
	// Go through each filterID and retrieve it as a Filter object.
	if (results) {
		let filters: Filter[] = [];
		for (let rowData of results.rows) {
			filters.push(rowDataToFilter(rowData));
		}
		return filters;
	}
	return [];
}

// #endregion USER AND FILTER INTERACTION

// ==================================
// USER SUBSCRIPTION AND NOTIFICATION
// ==================================
// #region

/** Removes the given push subscription for a user, if it exists. Ignores
 *  repeat subscriptions for the device associated with other users.
 */
export async function removeUserPushSubscription(
	client: PoolClient | Pool,
	userID: number,
	subscription: Subscription
) {
  await queryAndLog(
		client,
		`DELETE FROM ${DB_TABLE_SUBSCRIPTIONS}
      WHERE ${DB_ENDPOINT} = $1 AND ${DB_USER_ID} = $2;`,
		[subscription.endpoint, userID]
	);
}

/** Deletes all subscriptions with a matching endpoint, regardless of user. */
export async function deletePushSubscription(
	client: PoolClient | Pool,
	subscription: Subscription
) {
	await queryAndLog(
		client,
		`DELETE FROM ${DB_TABLE_SUBSCRIPTIONS}
      WHERE ${DB_ENDPOINT} = $1;`,
		[subscription.endpoint]
	);
}

/**
 * Updates a user's data with the expiration time of the last item the user was
 * notified about. Used to prevent repeat notifications and to mark which
 * users have already been notified.
 */
export async function updateLastNotifiedExpiration(
	client: PoolClient | Pool,
	userID: number,
	latestExpiration: number
) {
	await queryAndLog(
		client,
		`UPDATE ${DB_TABLE_USERS} SET 
      ${DB_LAST_NOTIFIED_EXPIRATION}  = $1
      WHERE ${DB_USER_ID} = $2;`,
		[latestExpiration, userID]
	);
}

/**
 * Returns the expiration timestamp of the last item the given user was notified
 * about. If no such user exists, returns -1.
 */
export async function getLastNotifiedExpiration(
	client: PoolClient | Pool,
	userID: number
): Promise<number> {
	let result = await queryAndLog(
		client,
		`SELECT ${DB_LAST_NOTIFIED_EXPIRATION} FROM ${DB_TABLE_USERS}
      WHERE ${DB_USER_ID} = $1;`,
		[userID]
	);
	if (
		result.rowCount > 0 &&
		result.rows[0][DB_LAST_NOTIFIED_EXPIRATION] !== null
	) {
		return result.rows[0][DB_LAST_NOTIFIED_EXPIRATION];
	} else {
		return -1;
	}
}

/**
 * Returns an array of subscription data for the given user. Returns an empty
 * array if no subscription could be found.
 */
export async function getUserSubscriptions(
	client: PoolClient | Pool,
	userID: number
): Promise<Subscription[]> {
	// Get all subscriptions that match this user
	let result = await queryAndLog(
		client,
		`SELECT * FROM ${DB_TABLE_SUBSCRIPTIONS}
      WHERE ${DB_USER_ID} = ${userID}`
	);

	if (result && result.rowCount > 0) {
		// Parse each row into its own subscription object.
		let subscriptions = [];
		for (let row of result.rows) {
			subscriptions.push(
				new Subscription(row[DB_ENDPOINT], row[DB_EXPIRATION], {
					auth: row[DB_AUTH_KEY],
					p256dh: row[DB_P256DH_KEY],
				})
			);
		}
		return subscriptions;
	}
	return [];
}

/**
 * Returns all users with filters that match the gear item. Users are returned
 * as mappings of user ID and user code.
 */
export async function getUsersToBeNotified(
	client: PoolClient | Pool,
	gear: Gear
): Promise<Map<number, string>> {
	// Prevent SQL injection attacks.
	// Allow only alphanumeric characters, spaces, and -, +, (, and ) chars.
	const allowedCharsPattern = new RegExp(/^[A-Za-z0-9-+()&' ]*$/);
	if (!allowedCharsPattern.test(gear.name)) {
		throw new IllegalArgumentError(
			"Gear name '" + gear.name + "' contains special characters."
		);
	}
	// Match filters by properties, either by specific brand/ability/type or by
	// wildcard selectors. Then, select all users that match any of those filters.
  // TODO: Ignore users who have already been notified via timestamp param?
	let result = await client.query(
		`WITH matchingUserIDs(_${DB_USER_ID}) AS (
      WITH matchingFilters(_${DB_FILTER_ID}) AS (
        SELECT ${DB_FILTER_ID} FROM ${DB_TABLE_FILTERS}
            WHERE ${DB_GEAR_RARITY} <= ${gear.rarity}
            AND (${DB_GEAR_NAME} = '' OR ${DB_GEAR_NAME} = $1)
            AND (${DB_GEAR_ABILITY_WILDCARD} OR ${formatCol(gear.ability)})
            AND (${DB_GEAR_TYPE_WILDCARD} OR ${formatCol(gear.type)})
            AND (${DB_GEAR_BRAND_WILDCARD} OR ${formatCol(gear.brand)})
      )
      SELECT ${DB_USER_ID} FROM ${DB_TABLE_USERS_TO_FILTERS}, matchingFilters
        WHERE ${DB_TABLE_USERS_TO_FILTERS}.${DB_FILTER_ID} = matchingFilters._${DB_FILTER_ID}
    )
    SELECT DISTINCT ON (${DB_USER_ID}) ${DB_USER_ID}, ${DB_USER_CODE} FROM ${DB_TABLE_USERS}, matchingUserIDs
      WHERE ${DB_TABLE_USERS}.${DB_USER_ID} = matchingUserIDs._${DB_USER_ID}
    ;`,
		[gear.name] // passed as a parameter for safety
	);

	// Return user data as a map from ID to code.
	let userMap = new Map<number, string>();
	if (result && result.rowCount > 0) {
		for (let row of result.rows) {
			userMap.set(row[DB_USER_ID], row[DB_USER_CODE]);
		}
	}
	return userMap;
}

/**
 * Attempts to send a notification to the given subscription endpoint, and
 * handles cleanup if the message was unsuccessful. Returns the result (as
 * returned from {@link webpush.sendNotification()}) on completion.
 *
 * Deletes the push subscription from the server if the request returned with
 * status codes 404 (endpoint not found) or 410 (subscription expired).
 *
 * Note: you must configure webpush BEFORE attempting to send notifications.
 * (aka, call {@link configureWebPush()} before running.)
 */
export async function trySendNotification(
	client: Pool | PoolClient,
	subscription: Subscription,
	notification: string,
  options = {}
): Promise<webpush.SendResult | undefined> {
  // TODO: Make multiple attempts at notifying users?
	try {
		let result = await webpush.sendNotification(
			subscription,
			notification,
      options
			// {timeout: 5}
		);
		return result;
	} catch (error) {
		if (error instanceof webpush.WebPushError) {
			if (
				error.statusCode === 404 ||
				error.statusCode === 410 ||
				error.statusCode === 403
			) {
				// 404: endpoint not found, 410: push subscription expired
				// 403: incorrect/changed keys
				// Remove this subscription from the database.
				await deletePushSubscription(client, subscription);
				return;
			} else {
				console.log(error.statusCode);
				throw error;
			}
		}
		throw error;
	}
}

// #endregion USER SUBSCRIPTION AND NOTIFICATION ACCESS

export function getDBClient(): Pool {
	const pgString = getEnvWithDefault(ENV_KEY_PGSTRING, null);
	if (pgString) {
		// Use PG string instead of variables
		return new Pool({ connectionString: pgString });
	} else {
		return new Pool({
			host: getEnvWithDefault(ENV_KEY_PGHOST, ""),
			user: getEnvWithDefault(ENV_KEY_PGUSER, ""),
			port: Number.parseInt(getEnvWithDefault(ENV_KEY_PGPORT, "")),
			password: getEnvWithDefault(ENV_KEY_PGPASSWORD, ""),
			database: getEnvWithDefault(ENV_KEY_PGDATABASE, ""),
		});
	}
}
