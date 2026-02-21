# AO3 Bunker

A tiny AO3 reading list that lives right on the page. Save works, pick up where you left off, mark things read, delete what you're done with. No account needed, no cloud sync, no judgment—just your browser's local storage and a little floating button.

Works on mobile or desktop, and tries to make the most of each.

## Install

1. Get [Tampermonkey](https://www.tampermonkey.net/) (or your preferred userscript manager)
2. Create a new script and paste in `ao3_bunker.user.js`
3. Go to AO3. That's it.

## Usage

The 📦 button shows up on the homepage and on any work page.

On a fic, it'll disappear as soon as you start scrolling down, then come back whenever you scroll up a little.

On the homepage, it'll stay visible so you can get to your fics. (You can also go directly to `https://archiveofourown.org#bunker` to load the page with the reading list already popped up.)

Swipe left to delete fics from your list. Swipe right to toggle read/unread, with an option to only show unread fics.

If you're reading a multi-chapter fic, your bookmark automatically updates to whatever chapter you're currently on. If you view the full work (`?view_full_work=true`), it saves that instead and the chapter label goes away.

Once the fic list is summoned, tapping the button again (or outside the list) dismisses it.

## Storage

Your reading list lives in Tampermonkey's storage under the key `ao3_bunker`. Preferences (just the "hide read" toggle for now) are under `ao3_bunker_prefs`. If you ever need to nuke everything, you can clear these from Tampermonkey's storage tab for the script.
