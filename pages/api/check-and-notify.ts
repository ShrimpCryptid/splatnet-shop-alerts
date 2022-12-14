import type { NextApiRequest, NextApiResponse } from "next";
import {
	getDBClient,
	getLastNotifiedExpiration,
	getUsersToBeNotified,
	getUserSubscriptions,
	trySendNotification,
	updateLastNotifiedExpiration,
} from "../../lib/database_utils";
import {
	fetchAPIRawGearData,
	fetchCachedRawGearData,
	getNewGearItems,
	rawGearDataToGearList,
	updateCachedRawGearData,
} from "../../lib/gear_loader";
import { Gear } from "../../lib/gear";
import { BASE_SPLATNET_URL, BASE_WEBSITE_URL, configureWebPush } from "../../lib/backend_utils";
import { getEnvWithDefault } from "../../lib/shared_utils";
import { ENV_KEY_ACTION_SECRET } from "../../constants/env";
import { FE_USER_CODE_URL } from "../../constants";
import { Pool } from "pg";

const MILLISECONDS_PER_SECOND = 1000.0;

function getUserGear(
	gearToUsers: Map<Gear, Map<number, string>>,
	userID: number
): Gear[] {
	let gearList = [];
	for (let [gear, userMap] of gearToUsers.entries()) {
		if (userMap.has(userID)) {
			gearList.push(gear);
		}
	}
	return gearList;
}

function aggregateUsers(gearToUserMap: Map<Gear, Map<number, string>>) {
  let allUserMap = new Map<number, string>();
  for (let userMap of gearToUserMap.values()) {
    allUserMap = new Map([...allUserMap, ...userMap]);
  }
  return allUserMap;
}

async function getUsersToNotify(client: Pool, newGear: Gear[]) {
  let promises: Promise<any>[] = [];
  let gearToUserMap = new Map<Gear, Map<number, string>>();

  // Parallelize requests for user data due to network
  for (let gear of newGear) {
    promises.push(new Promise<void>((resolve, reject) => {
      try {
        return getUsersToBeNotified(client, gear).then((value: Map<number, string>) => {
          gearToUserMap.set(gear, value);
          resolve();
        });
        
      } catch (e) {
        console.error("The following error occurred while trying to get users for gear '" + gear.name + "'. Skipping...")
        console.error(e);
        reject();
      }
    }));
  }
  await Promise.all(promises);
  return gearToUserMap;
}

/**
 * Generates an options object for the web push notifications. Currently just
 * generates the TTL (time to life) parameter so that the notification expires
 * if any gear items also expire.
 */
function generateNotificationOptions(gear: Gear): any {
  // Calculate timeout-- should be from now until gear's expiration date.
  let timeDiffMilliseconds = gear.expiration - Date.now();
  let timeDiffSeconds = Math.floor(timeDiffMilliseconds / MILLISECONDS_PER_SECOND);

  return {
    TTL: timeDiffSeconds  // Time (in seconds) that notification is retained
  }
}

function generateNotificationPayload(userCode: string, gear: Gear): any {
	let title,
		body = "",
		image = "";
  
  let loginURL = `${BASE_WEBSITE_URL}/login?${FE_USER_CODE_URL}=${userCode}`;
  let gearID = gear.id;
  title = "Now on SplatNet!";
  body = gear.name + ": " + gear.ability;
  // image = gear.image;

  // When updating this, remember to make changes in serviceworker.js!
	return {
		title: title,
		body: body,
		image: image,
    // Use gear image as the icon.
    iconURL: gear.image,  // TODO: Generate icon for notifications
    loginURL: loginURL,  // used to log in to the website
    siteURL: BASE_WEBSITE_URL,
    shopURL: BASE_SPLATNET_URL,
    gearID: gearID,
    userCode: userCode,
    tag: gear.id,  // tag for this notification, to prevent duplicates
    expiration: gear.expiration
	};
}

/**
 * Checks for new changes to the Splatnet shop, via the Splatoon3.ink API and a
 * local cache. If changes are found, notifies all users that have filters for
 * those new items.
 *
 * @return A response with one of the following response codes:
 *  - 200 once all operations have completed.
 *  - 500 if any other errors encountered.
 */
export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse
) {
	// Validate input

	try {
		let client = getDBClient();

		// 0. Check authentication on the request-- must match stored API key.
		// Note: providing an empty string for the secret key will skip checks.
		let secretKey = getEnvWithDefault(ENV_KEY_ACTION_SECRET, null);
		let providedKey = req.headers.authorization;
		if (!secretKey) {
			// Secret key is undefined-- assume that this is an error.
			console.warn("Secret key 'ACTION_SECRET' is not defined. This is okay ONLY in testing environments.");
		} else if (secretKey === providedKey) {
			console.log("Secret key matches. Request authenticated.");
		} else {
			console.error("Unauthorized request: keys do not match.");
			return res.status(401).end();
		}

		// 1. Check for new/expired gear items.
		let cachedRawGearData = await fetchCachedRawGearData(client);
		let cachedGear: Gear[];
		if (cachedRawGearData == null) {
			// store a default value in case no cache
			cachedGear = [];
		} else {
			cachedGear = rawGearDataToGearList(cachedRawGearData);
		}

		// Check if gear has expired (or if we have no stored gear data)
		// Note that gear is sorted in order of expiration, ascending
		if (cachedGear.length > 0 && Date.now() < cachedGear[0].expiration) {
			// Cache has not expired, so do not notify users.
			return res.status(425).end(); // 425 means 'Too Early'
		}

		// Retrieve the new gear data from the API.
		let fetchedRawGearData = await fetchAPIRawGearData();
		let fetchedGear = rawGearDataToGearList(fetchedRawGearData);

		// 2. Get list of new gear items.
		let newGear = getNewGearItems(cachedGear, fetchedGear);

		// 3. Get lists of users to notify.
		let gearToUserMap = await getUsersToNotify(client, newGear);
    let allUserMap = aggregateUsers(gearToUserMap);

		console.log("Notifying " + allUserMap.size + " users.");

		// 4. Configure webpush
		configureWebPush();

		// 5. Send each user notifications to their subscribed devices.
		// TODO: Refactor into a separate method.
    let startTime = Date.now();
		let numAlreadyNotified = 0;
		let numNoSubscriber = 0;
		let devicesNotified = 0;
		let devicesFailed = 0;

		let promises = [];
		for (let [userID, userCode] of allUserMap) {
			// Set up the notification *this* user should receive.
      let notifications: [notification: string, options: any][] = [];
      let userGear = getUserGear(gearToUserMap, userID);

      for (let gear of userGear) {  // generate a unique notification per item
        let notification = JSON.stringify(generateNotificationPayload(userCode, gear));
        let options = generateNotificationOptions(gear);
        notifications.push([notification, options]);
      }
      // Assumption: usually all items have the same expiration because they are
      // uploaded to the shop at the same time.
			let latestExpiration = userGear[userGear.length - 1].expiration;

			// Check that we haven't already notified this user
			if (
				latestExpiration <= (await getLastNotifiedExpiration(client, userID))
			) {
				// We've already notified this user about these items, so we skip them.
				numAlreadyNotified++;
				continue;
			}

			// Send notification to all of the user's subscribed devices
			let notificationPromises = [];
			let userSubscriptions = await getUserSubscriptions(client, userID);
			if (userSubscriptions.length == 0) {
				// user has no subscribed devices
				numNoSubscriber++;
				continue;
			}

			for (let subscription of userSubscriptions) {
				devicesNotified++;
        // Send one notification for every item to this subscription endpoint
        for (let [notification, options] of notifications) {
          notificationPromises.push(
            trySendNotification(client, subscription, notification, options).then(
              (result) => {
                if (!result) {
                  devicesFailed++;
                }
              }
            )
          );
        }
			}
			// TODO: Skip if user was not actually notified?
			promises.push(
				Promise.all(notificationPromises).then(() => {
					// Update user entry once all devices have been notified.
					updateLastNotifiedExpiration(client, userID, latestExpiration);
				})
			);
		}

		// 6. Wait for all notifications to finish.
		await Promise.all(promises);

		// 7. Store the new cached gear data for the future.
		// We only do this AFTER all users have been notified in case of server
		// crashes-- if this happens, the server will pick up where it left off.
		await updateCachedRawGearData(client, fetchedRawGearData);

		// 8. Logging
		let timeElapsedSeconds = (Date.now() - startTime) / 1000.0;
		console.log(`Notifications done. (Finished in ${timeElapsedSeconds.toFixed(2)} seconds)`);
		let usersNotified = allUserMap.size - numAlreadyNotified - numNoSubscriber;
		console.log(`Users notified: ${usersNotified} users (${numAlreadyNotified} already notified, ${numNoSubscriber} with no devices)`);
		console.log(`Devices notified: ${devicesNotified - devicesFailed} devices (${devicesFailed} failures)`);

		return res.status(200).end(); // ok
	} catch (err) {
		console.log(err);
		return res.status(500).end(); // internal server error
	}
}
