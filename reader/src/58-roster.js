/* --------------------------------------------------------------- the roster --
 *
 * The follow / follower list, behind the two numbers on the profile header —
 * X's arrangement, and the one the report asked for: "粉丝关注肯定推特一样放".
 *
 * The data has been in the archive since the roster was added and this page has
 * never read it. `indexSource` scans the envelope for the key and records
 * `hasRoster`; that flag was only ever used to print "这个页面不显示它". Here it
 * finally means something.
 *
 * LAZY, and not as an optimisation. A roster is one row per person and runs to
 * tens of megabytes on a big account; reading it on every open would make
 * opening an archive cost something most opens never use. `hasRoster` is a
 * cheap byte scan, so the door can be offered without paying for the room.
 *
 * The union rule is NOT re-implemented here. `groupConnections` already merges
 * a group's rosters with "the later sighting wins", and the export writes that
 * same answer out; a second copy of the rule would let the list on screen and
 * the list in the file disagree.
 */

var roster = {
  loaded: false,      /* the rows have been read for the CURRENT set of sources */
  loading: false,
  rows: [],
  error: null,
  list: 'following',  /* which of the two lists is on screen */
  q: ''
};

/** Called from resetArchive: a different set of sources is a different roster. */
function resetRoster() {
  roster.loaded = false;
  roster.loading = false;
  roster.rows = [];
  roster.error = null;
  roster.list = 'following';
  roster.q = '';
  if (el.rosterFilter) el.rosterFilter.value = '';
}

/** True when at least one open source says it carries a roster. */
function rosterAvailable() {
  return archive.envelope !== null && archive.envelope.hasRoster === true;
}

/**
 * Read every open source's roster, once.
 *
 * Anything that goes wrong is a sentence on the page, never a throw: the roster
 * is a side room of the archive, and failing to open it must not take the
 * timeline down with it.
 */
async function loadRoster() {
  if (roster.loaded || roster.loading) return roster;
  roster.loading = true;
  roster.error = null;
  try {
    var groups = groupSourcesByAccount();
    var all = [];
    for (var g = 0; g < groups.length; g++) {
      var got = await groupConnections(groups[g]);
      for (var i = 0; i < got.rows.length; i++) all.push(got.rows[i]);
    }
    roster.rows = all;
    roster.loaded = true;
  } catch (err) {
    roster.error = err && err.message ? String(err.message) : '读不出来';
  } finally {
    roster.loading = false;
  }
  return roster;
}

/** One row of the list, as X draws one: face, name, handle, bio. */
function rosterRow(row) {
  var wrap = document.createElement('div');
  wrap.className = 'rp__row';

  var handle = asText(row.screenName);
  wrap.appendChild(avatarNode({
    id: asText(row.userId),
    screenName: handle,
    name: asText(row.name),
    avatarUrl: asText(row.avatarUrl)
  }, 48));

  var who = document.createElement('div');
  who.className = 'rp__who';

  var line = document.createElement('div');
  var name = asText(row.name);
  line.appendChild(span('rp__name', name !== '' ? name : (handle !== '' ? '@' + handle : '（没有名字）')));
  if (handle !== '') line.appendChild(span('rp__handle', ' @' + handle));
  who.appendChild(line);

  var bio = asText(row.bio);
  if (bio !== '') who.appendChild(span('rp__bio', bio));

  wrap.appendChild(who);
  return wrap;
}

/** Does this row belong in the current filter? Empty query means everything. */
function rosterMatches(row) {
  if (roster.q === '') return true;
  var hay = [row.name, row.screenName, row.bio, row.userId]
    .map(function (v) { return asText(v).toLowerCase(); })
    .join(' ');
  var terms = roster.q.toLowerCase().split(/\s+/).filter(function (t) { return t !== ''; });
  for (var i = 0; i < terms.length; i++) {
    if (hay.indexOf(terms[i]) === -1) return false;
  }
  return true;
}

/** Paint the two tabs, the count, and the rows of whichever list is showing. */
function paintRoster() {
  var buttons = el.rosterTabs.querySelectorAll('.tab');
  for (var b = 0; b < buttons.length; b++) {
    buttons[b].classList.toggle('on', buttons[b].dataset.list === roster.list);
  }

  if (roster.error !== null) {
    el.rosterList.textContent = '';
    el.rosterList.appendChild(span('rp__note', '名单读不出来：' + roster.error));
    el.rosterWhere.textContent = '';
    return;
  }

  var inList = [];
  for (var i = 0; i < roster.rows.length; i++) {
    if (asText(roster.rows[i].list) === roster.list) inList.push(roster.rows[i]);
  }
  var shown = inList.filter(rosterMatches);

  el.rosterWhere.textContent = shown.length === inList.length
    ? fmtCount(inList.length) + ' 人'
    : fmtCount(shown.length) + ' / ' + fmtCount(inList.length) + ' 人';

  el.rosterList.textContent = '';
  if (shown.length === 0) {
    el.rosterList.appendChild(span('rp__note', inList.length === 0
      ? '这份归档里没有' + (roster.list === 'following' ? '关注' : '粉丝') + '名单。'
        + '扩展只有在开关打开、并且你在 X 上翻过那一页时才会记下来。'
      : '没有匹配「' + roster.q + '」的人。'));
    return;
  }

  /* A fragment, so a thousand rows are one layout pass rather than a thousand. */
  var frag = document.createDocumentFragment();
  for (var k = 0; k < shown.length; k++) frag.appendChild(rosterRow(shown[k]));
  el.rosterList.appendChild(frag);
}

/**
 * Open the page on one of the two lists.
 *
 * The read happens AFTER the page is up, with a line saying so, because a big
 * roster takes a moment and a click that appears to do nothing is the failure
 * this project keeps meeting. The page is also the only place the spinner can
 * live: the button that opened it is about to be scrolled away from.
 */
async function openRoster(list) {
  if (el.postPage.hidden === false) closePostPage();
  roster.list = list === 'followers' ? 'followers' : 'following';
  el.rosterPage.hidden = false;
  document.body.classList.add('rosterOpen');
  el.rosterScroll.scrollTop = 0;
  el.rosterHeading.textContent = '名单';

  if (roster.loaded) { paintRoster(); return; }
  el.rosterList.textContent = '';
  el.rosterList.appendChild(span('rp__note', '正在读名单…'));
  el.rosterWhere.textContent = '';
  await loadRoster();
  paintRoster();
}

function closeRoster() {
  if (el.rosterPage.hidden) return;
  el.rosterPage.hidden = true;
  document.body.classList.remove('rosterOpen');
  el.rosterList.textContent = '';
  roster.q = '';
  if (el.rosterFilter) el.rosterFilter.value = '';
}

if (el.btnRosterBack) el.btnRosterBack.addEventListener('click', closeRoster);

if (el.rosterTabs) {
  el.rosterTabs.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('.tab') : null;
    if (!btn) return;
    var list = btn.dataset.list;
    if (list === roster.list) return;
    roster.list = list;
    el.rosterScroll.scrollTop = 0;
    paintRoster();
  });
}

if (el.rosterFilter) {
  el.rosterFilter.addEventListener('input', function () {
    roster.q = el.rosterFilter.value.trim();
    paintRoster();
  });
}
