/* ---------------------------------------------------------------- 我 ---
 *
 * The accounts that are open, one card each.
 *
 * A list of PEOPLE, not of files. Two exports of one handle are one account,
 * and showing them as two cards would be showing the same person twice — and
 * then offering to remove half of them. The grouping is
 * groupSourcesByAccount() in 80-export.js, which is the same grouping 合并导出
 * writes its files by: a card here and a file out of there can never mean
 * different things.
 *
 * What a card says is only what the envelope already holds. Notably absent is
 * the span of years the archive covers: that is a fact about the RECORDS, and
 * the only way to it is to read every one of them. A page that is redrawn
 * whenever the set of open files changes is the wrong place to spend a pass
 * over the whole file, and a range guessed from the first and last row would
 * be wrong on exactly the merged files this page exists for.
 * ------------------------------------------------------------------------ */

/* The account the timeline is narrowed to, as a group key, or null for "all of
   them". It lives here rather than beside `accountIds` because accountIds is a
   snapshot of record indices that a rebuild throws away, while this survives
   one — it is what puts the narrowing back. */
var activeAccount = null;

/** The handle a group's own profile claims, or null. */
function groupHandle(g) {
  var p = g && g.profile;
  var h = p && typeof p.screenName === 'string' ? p.screenName : '';
  return h.length > 0 ? h : null;
}

/** The display name a group's own profile claims, or null. */
function groupName(g) {
  var p = g && g.profile;
  var n = p && typeof p.name === 'string' ? p.name : '';
  return n.length > 0 ? n : null;
}

/** How many records the whole group has in the merged list, after folding. */
function groupRecordCount(g) {
  var n = 0;
  for (var i = 0; i < g.sources.length; i++) n += recordCountOf(g.sources[i]);
  return n;
}

/**
 * How many media FILES the group's archives carry.
 *
 * Counted off the media map each source built while it was being opened — a
 * count of entries in the ZIP, not a pass over the records. Zero for a JSON
 * export, which carries no files at all, and that is a true zero rather than a
 * number that could not be found.
 */
function groupMediaCount(g) {
  var n = 0;
  for (var i = 0; i < g.sources.length; i++) {
    var m = archive.sources[g.sources[i]].mediaMap;
    if (m && typeof m.size === 'number') n += m.size;
  }
  return n;
}

/**
 * When this account's card was last seen, or when its file was written.
 *
 * The same two fields, in the same order, that groupSourcesByAccount() uses to
 * decide which of several profiles is the freshest — so the date printed under
 * a name belongs to the card shown above it, and not to a different export of
 * the same account.
 */
function groupUpdatedAt(g) {
  var p = g && g.profile;
  var seen = p && typeof p.lastSeenAt === 'string' && p.lastSeenAt.length > 0 ? p.lastSeenAt : null;
  var made = null;
  for (var i = 0; i < g.sources.length; i++) {
    var e = archive.sources[g.sources[i]].envelope;
    var at = e && typeof e.exportedAt === 'string' ? e.exportedAt : '';
    if (at.length > 0 && (made === null || at > made)) made = at;
  }
  return shortDay(seen !== null ? seen : made);
}

/** `2026-09-21` in the display zone, or null. Not a clock: this is a caption. */
function shortDay(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  var ms = Date.parse(iso);
  if (!isFinite(ms)) return null;
  var d = zoneDate(ms);
  var m = d.getUTCMonth() + 1;
  var day = d.getUTCDate();
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

/** One of a card's three buttons. */
function meButton(label, run) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.textContent = label;
  b.addEventListener('click', function () { run(); });
  return b;
}

/**
 * One account, as a chunk of the 我 page.
 *
 * Every value goes in through textContent — a name, a bio and a handle are all
 * things somebody else chose, and this page renders them the same way the cards
 * and the profile header do.
 */
function meCard(g) {
  var p = g.profile && typeof g.profile === 'object' ? g.profile : {};
  var h = groupHandle(g);
  var nm = groupName(g);

  var card = document.createElement('div');
  card.className = 'me__card';

  var head = document.createElement('div');
  head.className = 'me__head';
  /* The same node the timeline and the header use, so the letter disc, the
     inlined picture the export carries and the `他人头像` opt-in gate are all
     the same three rules here as everywhere else. 48px inline: this avatar is
     a parameter of the call, not a state of the page. */
  head.appendChild(avatarNode({
    id: typeof p.userId === 'number' ? String(p.userId) : asText(p.userId),
    screenName: h === null ? '' : h,
    name: nm === null ? '' : nm,
    avatarUrl: asText(p.avatarUrl),
    avatarData: asText(p.avatarData)
  }, 48));

  var who = document.createElement('div');
  who.className = 'me__who';
  /* A source with no profile at all — a hand-built or truncated file — has no
     handle and no name, and the only true thing left to call it is the file it
     came from. */
  who.appendChild(span('me__name', nm || (h === null ? '' : '@' + h) || g.sources.map(function (k) {
    return archive.sources[k].file.name;
  }).join(' + ')));
  if (h !== null) who.appendChild(span('me__handle', '@' + h));
  head.appendChild(who);
  card.appendChild(head);

  var bio = asText(p.bio);
  if (bio) {
    var bp = document.createElement('p');
    bp.className = 'me__bio';
    bp.textContent = bio;
    /* Clamped to three lines, and the clamp is invisible — so the whole text,
       newlines and all, is one hover away. */
    bp.title = bio;
    card.appendChild(bp);
  }

  var bits = [fmtCount(groupRecordCount(g)) + ' 条推文'];
  var media = groupMediaCount(g);
  if (media > 0) bits.push(fmtCount(media) + ' 张图');
  if (g.sources.length > 1) bits.push(g.sources.length + ' 个归档文件');
  var updated = groupUpdatedAt(g);
  if (updated !== null) bits.push('最后更新 ' + updated);
  var meta = document.createElement('p');
  meta.className = 'me__meta';
  meta.textContent = bits.join(' · ');
  card.appendChild(meta);

  var acts = document.createElement('div');
  acts.className = 'me__acts';
  /* Only when there is somewhere to go. `#/@handle` is the address of this
     account, and an account with no handle has no address — so that one card
     offers the two actions that do not need one. */
  if (h !== null) {
    acts.appendChild(meButton('打开', function () {
      go({ name: 'account', handle: h });
    }));
  }
  acts.appendChild(meButton('＋ 加这个账号的其他归档', function () { el.pick.click(); }));
  acts.appendChild(meButton('移除', function () { void removeGroup(g); }));
  card.appendChild(acts);

  return card;
}

/**
 * Close every archive that makes up one account.
 *
 * One source at a time, through the path that already knows how to rebuild —
 * dedupe, sort, renumber, repaint. Splicing them all out first would renumber
 * the list underneath the loop that was walking it. Highest index first, so
 * the ones still to be removed keep the numbers they were found under.
 */
async function removeGroup(g) {
  var wasActive = g.key === activeAccount;
  for (var i = g.sources.length - 1; i >= 0; i--) {
    await removeSourceAt(g.sources[i]);
  }
  /* The account the reader was looking at is gone, so the address that names it
     is a dead link. 我 是 where they were, and it is where the change shows. */
  if (wasActive) replaceRoute({ name: 'me' });
}

/**
 * The 我 page, from the archives that are open.
 *
 * Called from renderAccounts(), which is the one function both armEmptyView()
 * and commitSources() go through — so closing the last archive repaints this
 * as surely as opening the first one does.
 */
function refreshMe() {
  if (!el.meList) return;
  var groups = groupSourcesByAccount();

  /* Which of the two halves of the page is on screen. #drop is the empty state
     and its display is switched in three places in 20-loading.js; this is the
     fourth and the one that survives them all, because renderAccounts() runs on
     both paths. */
  el.drop.style.display = groups.length === 0 ? '' : 'none';
  el.meScroll.hidden = groups.length === 0;

  el.meList.textContent = '';
  for (var i = 0; i < groups.length; i++) el.meList.appendChild(meCard(groups[i]));

  if (groups.length > 0) {
    var add = meButton('＋ 添加归档', function () { el.pick.click(); });
    add.className = 'btn me__add';
    el.meList.appendChild(add);
  }
}
