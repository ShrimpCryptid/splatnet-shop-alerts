import Head from "next/head";
import Link from "next/link";
import Router from "next/router";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import Filter from "../lib/filter";
import FilterView from "../components/filter-view";
import styles from "../styles/index.module.css";
import { API_FILTER_JSON, API_SEND_TEST_NOTIFICATION, API_SUBSCRIPTION, API_USER_CODE, FE_ERROR_404_MSG, FE_ERROR_500_MSG, FE_ERROR_INVALID_USERCODE } from "../constants";
import { DefaultPageProps } from "./_app";
import { requestNotificationPermission, registerServiceWorker, createNotificationSubscription } from "../lib/notifications";
import SuperJumpLoadAnimation from "../components/superjump/superjump";
import { isValidUserCode } from "../lib/shared_utils";


/**
 * Retrieves a list of the user's current filters from the database.
 * @param userCode the unique string identifier for this user.
 */
async function getUserFilters(userCode: string): Promise<Filter[]|null> {
	// TODO: Use SWR fetcher?
  // TODO: URL-ify usercode.
  // TODO: Make multiple attempts to get a 200 response in case the server is
  // misbehaving.  
	let url = `/api/get-user-filters?${API_USER_CODE}=${userCode}`;
	let response = await fetch(url);
	if (response.status == 200) {
		// ok
		let jsonList = await response.json();
		let filterList = [];
		for (let json of jsonList) {
			filterList.push(Filter.deserializeObject(json));
		}
		return filterList;
	} else if (response.status === 404 && isValidUserCode(userCode)) {
    toast.error(FE_ERROR_404_MSG);
  } else if (response.status === 500 || response.status === 400) {
    toast.error(FE_ERROR_500_MSG);
  }
  return null;
}


export default function Home({
	usercode,
	setUserCode,
	setEditingFilter,
}: DefaultPageProps) {
  let [filterList, setFilterList] = useState<Filter[]|null>(null);
	let [pageSwitchReady, setPageSwitchReady] = useState(false);
  let [notificationsToggle, setNotificationsToggle] = useState(false);
  let [shouldFetchFilters, setShouldFetchFilters] = useState<boolean>(true);
  let [loginUserCode, setLoginUserCode] = useState("");
  let [filterText, setFilterText] = useState("Loading...");

	// Retrieve the user's filters from the database.
  const updateFilterViews = async () => {
    setFilterText("Loading...");  // Reset filter text while loading in text
    if (usercode !== null) {
      getUserFilters(usercode).then((filterList) => {
          if (filterList && filterList.length > 0) {
            setFilterList(filterList);
          } else {
            setFilterList([]);
            setFilterText("There's nothing here yet.");
          }
        }
      );
    } else {
      setFilterList(null);  // store empty list
      setFilterText("There's nothing here yet. Make a new filter to get started.");
    }
  }
  // On initial render only, or whenever our usercode has changed.
  if (shouldFetchFilters) {
    setEditingFilter(null);  // clear the filter we are editing.
    updateFilterViews();
    setShouldFetchFilters(false);
  }

  // Click and edit a filter.
	const onClickFilter = (filter: Filter) => {
		// Switch page contexts, save the editing filter to the state.
		console.log(filter);
		setEditingFilter(filter);
		setPageSwitchReady(true);
	};

  // Switches page to the filter edit/creation, but only when state has finished
  // changing.
	useEffect(() => {
		if (pageSwitchReady) {
			Router.push("/filter");
		}
	});

  /** Attempts to delete the filter given by the index from the server. */
  const onClickDeleteFilter = (filterIndex: number) => {
    async function deleteFilter(filterIndex: number) {
      if (filterList) {
        let filter = filterList[filterIndex];
        let url = `/api/delete-filter?${API_USER_CODE}=${usercode}`;
        url += `&${API_FILTER_JSON}=${filter.serialize()}`
        let result = await fetch(url);
        if (result.status == 200) {
          // Remove filter from the list locally too
          let newFilterList = [...filterList];  // shallow copy
          newFilterList.splice(filterIndex, 1);
          setFilterList(newFilterList);
          if (newFilterList.length === 0) {
            // Reset filter text
            setFilterText("There's nothing here yet.");
          }
        } else {
          // TODO: Error message
        }
      }
    }
    deleteFilter(filterIndex);
  }

  const toggleNotifications = async () => {
    if (notificationsToggle) {
      // Turn OFF notifications
      // TODO: Remove subscription from server -> await then
      toast("Notifications have been disabled for this device.");
      setNotificationsToggle(false);
    } else {
      // Turn ON notifications
      // Start a local service worker
      await requestNotificationPermission();
      await registerServiceWorker();

      const publicVAPIDKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!publicVAPIDKey) {
        console.error("Cannot find public VAPID key environment variable.");
        return;
      }
      // TODO: Handle 'DOMException: Registration failed' when VAPID keys have changed.
      // TODO: Determine why notifications don't work correctly the first time they're registered?
      let subscription = await createNotificationSubscription(publicVAPIDKey);
      let subscriptionString = JSON.stringify(subscription);
      // TODO: Store locally?
      
      // Send the subscription data to the server and save.
      let url = `/api/subscribe?${API_SUBSCRIPTION}=${subscriptionString}`;
      url += `&${API_USER_CODE}=${usercode}`;
      url += `&${API_SEND_TEST_NOTIFICATION}`;  // flag: send test notif.
      let result = await fetch(url);
      if (result.status === 200) {
        toast.success("Success! A test notification has been sent to your device.");
      } else if (result.status === 404) {
        toast.error(FE_ERROR_404_MSG);
      } else if (result.status === 500) {
        toast.error(FE_ERROR_500_MSG);
      }
    }
  }

  /** Updates the login field as the user types. */
  const handleLoginChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLoginUserCode(event.currentTarget.value);
  }

  const onClickLogin = () => {
    if (!isValidUserCode(loginUserCode)) {
      toast.error(FE_ERROR_INVALID_USERCODE);
      return;
    }
    // TODO: Attempt to log user in, and only allow switch if the server has
    // a valid entry for the user.
    setUserCode(loginUserCode);
    setShouldFetchFilters(true);
  }

	return (
		<div className={styles.main}>
			<Head>Splatnet Shop Alerts</Head>
			<div>
				<div>
					<h1>Splatnet Shop Alerts (SSA)</h1>
					<p>Get notified about gear from the SplatNet 3 app!</p>
				</div>
			</div>
			<h2>Your Filters</h2>
      <button onClick={updateFilterViews}>
        <span className="material-symbols-outlined">sync</span>
      </button>
			<div className={styles.filterListContainer}>
        {(filterList && filterList.length > 0) ? filterList.map((filter, index) => {
          return (
            <FilterView
              onClickEdit={() => onClickFilter(filter)}
              onClickDelete={() => onClickDeleteFilter(index)}
              filter={filter}
              key={index}
            />
          );
        }) :
        (<div className={styles.emptyFilterList}>
          <SuperJumpLoadAnimation
            filterText={filterText}
            fillLevel={0.5}
          />
        </div>)}
      </div>
			<Link href="filter">
				<button>New Filter</button>
			</Link>

			<h2>Settings</h2>
			<h3>Notifications</h3>
			<p>
				You currently have notifications <b>ON/OFF</b>.
			</p>
			<p>
				SSA sends push notifications via your browser. You can turn off
				notifications at any time.
			</p>
			<button disabled={false} onClick={toggleNotifications}>
        Turn on notifications
      </button>
			<h3>User ID</h3>
			<p>This is your unique user ID. Save and copy this somewhere secure!</p>
			<p>
				You can use it to make changes to your notifications if you clear your
				cookies or use another browser.
			</p>
			<p>
				<b>Your unique identifier is:</b>
			</p>
			<textarea value={usercode ? usercode : ""} readOnly={true}/>
			<button>📄</button>

			<h3>Change User</h3>
			<p>
				Paste in your user ID to sync your notification settings across devices.
			</p>
			<textarea value={loginUserCode} onChange={handleLoginChange} />
			<button onClick={onClickLogin}>Login</button>
		</div>
	);
}
