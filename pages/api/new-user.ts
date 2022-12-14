import type { NextApiRequest, NextApiResponse } from "next";
import { getDBClient, makeNewUser } from "../../lib/database_utils";

/**
 * Requests a new user identifier from the server.
 *
 * @param req http request.
 *
 * @return A response with one of the following response codes:
 *  - 200 if a new user was registered, with the resulting code in the response JSON.
 *  - 500 if any other errors encountered.
 */
export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse
) {
	try {
		let client = getDBClient();
		let usercode = await makeNewUser(client);

		res.status(200).json(usercode);
		return res.end();
	} catch (err) {
		console.log(err);
		return res.status(500).end(); // internal server error
	}
}
