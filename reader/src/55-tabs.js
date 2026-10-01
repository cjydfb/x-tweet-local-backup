/* ---------------------------------------------------------------- tabs --
 *
 * The account header and the three tabs above the timeline.
 *
 * What is here and what is deliberately not:
 *
 *   - 转帖 and 文章 are absent. The extension does not match CreateRetweet, so
 *     no record in any archive is a retweet and a 转帖 tab would be empty
 *     forever; and a long-form post arrives through CreateNoteTweet and is
 *     stored as an ordinary record with ordinary text, so there is no predicate
 *     that would put anything in 文章 either. A tab that can never be filled is
 *     a claim about the file that is not true.
 *   - The filter is not a search. It narrows the archive's own order to a
 *     subset, and all three subsets come out of ONE scan of every record — the
 *     first tab click pays for that pass (measured: 76 ms over twenty thousand
 *     records read from memory, 173 ms over fifty thousand; a file on disk is
 *     slower), and every later one is instant.
 *   - Nothing here touches the byte-offset index or the height table. A tab is
 *     one more way of filling in `list.ids`, and every consumer of the list
 *     already goes through length()/at().
 * ------------------------------------------------------------------------ */

var filters = {
  posts: null,      /* record indices that are not replies */
  replies: null,    /* record indices that are replies */
  media: null,      /* record indices carrying at least one media item */
  /* The two maps the post page needs, filled by the same pass. One id lookup
     each way round: `byId` answers "where is the post this one replies to", and
     `repliesOf` answers "which of my posts reply to this one". Neither can be
     answered by scanning the visible list, because the other end of a
     conversation is usually not on screen and often not in the current tab. */
  byId: null,       /* tweetId -> record index */
  repliesOf: null,  /* tweetId -> record indices that name it in replyTo */
  built: false,     /* everything above is filled */
  building: null,   /* the promise of the pass in flight, or null */
  buildGen: -1      /* the generation that pass claimed */
};

/** What the tab row and the scope select currently ask the list to show. */
function currentFilter() {
  if (list.tab === 'replies') return 'replies';
  if (list.tab === 'media') return 'media';
  return list.scope === 'posts' ? 'posts' : 'all';
}

/** The filter lists are a fact about the FILE, so a new file drops them. */
function invalidateFilters() {
  filters.posts = null;
  filters.replies = null;
  filters.media = null;
  filters.byId = null;
  filters.repliesOf = null;
  filters.built = false;
  filters.building = null;
  filters.buildGen = -1;
}

/**
 * Is this record a reply — by either of the two marks it can carry.
 *
 * Both are checked because both exist in the wild. `isReply` is what this
 * extension writes; `replyTo` is what a record merged from another machine, or
 * written by an older version, carries instead. Reading only one of them files
 * some replies under 帖子 and some posts under 回复, which is a wrong answer
 * rather than a missing one.
 */
function isReplyRecord(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.isReply === true) return true;
  return !!(r.replyTo && r.replyTo.tweetId);
}

/**
 * Build all three filter lists in ONE pass over the archive.
 *
 * One pass, not three: the three lists are three readings of the same record
 * (is it a reply, does it carry media), so a reader who visits every tab would
 * otherwise read the whole file three times.
 *
 * Only one pass may be in flight. A second caller joins the pass that is already
 * running instead of starting a rival that would double the work and race it —
 * but it joins only while that pass still owns the generation. A pass that has
 * been superseded (another tab, a search, a new file) is dead: joining it would
 * hand this caller a cancellation it did not ask for.
 *
 * Resolves true when the lists are usable, false when the pass did not finish.
 */
function ensureFilters() {
  if (filters.built) return Promise.resolve(true);
  if (filters.building && filters.buildGen === search.gen) return filters.building;

  var gen = beginScan();
  filters.buildGen = gen;
  var posts = [], replies = [], media = [];
  var byId = new Map(), repliesOf = new Map();

  progressStart('正在建立筛选索引…');
  filters.building = scanRecords(function (idx, r) {
    if (search.gen !== gen) return;
    if (isReplyRecord(r)) replies.push(idx); else posts.push(idx);
    if (Array.isArray(r.media) && r.media.length > 0) media.push(idx);

    if (typeof r.id === 'string' && r.id.length > 0) byId.set(r.id, idx);
    /* The parent id is not validated here — it is looked up, not trusted, and a
       reply naming a tweet that is not in the archive simply finds nothing. */
    var parent = r.replyTo && typeof r.replyTo.tweetId === 'string' ? r.replyTo.tweetId : null;
    if (parent !== null && parent.length > 0) {
      var kids = repliesOf.get(parent);
      if (kids === undefined) repliesOf.set(parent, [idx]);
      else kids.push(idx);
    }
  }, gen, '正在建立筛选索引…').then(function (outcome) {
    /* Superseded. A newer job owns the bar and the progress text, so this one
       must not take the bar down, and must not write into `filters` — the
       arrays it is holding are for a list nobody is looking at. */
    if (gen !== search.gen) return false;
    filters.building = null;
    progressEnd();
    if (outcome !== 'done') return false;
    filters.posts = posts;
    filters.replies = replies;
    filters.media = media;
    filters.byId = byId;
    filters.repliesOf = repliesOf;
    filters.built = true;
    return true;
  });
  return filters.building;
}

/**
 * Which tab click is the current one.
 *
 * A click that has been superseded must not repaint the row or revert a tab the
 * reader has chosen since — and the filter build it is waiting on can take a
 * third of a second, which is long enough for another click to arrive.
 */
var tabs = { gen: 0 };

/**
 * Show one tab.
 *
 * The order of the steps is the whole of it. cancelScan() first, so a search
 * still running cannot land after the list has been replaced and print its
 * results over the new one. The filter build second, because nothing below it
 * can be computed until the list exists. The scroll reset last, inside
 * applyList, because every list is applied through the one path that also
 * resizes the height table — and the table is sized from the list.
 *
 * The search is CLEARED rather than intersected with. composeList can intersect
 * the two, but a tab is a request to see that column's records, and a query left
 * in the box while the list shows more than it matched — or fewer — is a control
 * that disagrees with what is on screen.
 */
async function selectTab(tab, scope) {
  if (tab !== 'posts' && tab !== 'replies' && tab !== 'media') return;
  var prevTab = list.tab, prevScope = list.scope;
  var token = ++tabs.gen;
  var fileGen = archive.gen;

  list.tab = tab;
  if (tab === 'posts') list.scope = scope === 'posts' ? 'posts' : 'all';

  cancelScan();
  paintTabs();

  if (currentFilter() !== 'all') {
    var ok = await ensureFilters();
    /* A different file is open, or a later click has taken over: whoever
       replaced this one owns the screen now and will paint it. */
    if (token !== tabs.gen || fileGen !== archive.gen) return;
    if (!ok) {
      list.tab = prevTab;
      list.scope = prevScope;
      paintTabs();
      say('<div class="box warn">筛选索引没有建完（被取消，或被别的操作取代），这一栏没有切换。' +
          '再点一次可以重来。</div>', 'warn');
      return;
    }
  }

  list.mode = 'timeline';
  list.q = '';
  list.terms = [];
  list.hits = [];
  search.hits = 0;
  el.q.value = '';
  composeList();
  applyList(true);
  say('');
}

/** The tab row's .on state and the scope select's visibility, from `list`. */
function paintTabs() {
  var buttons = el.tabs.querySelectorAll('.tab');
  for (var k = 0; k < buttons.length; k++) {
    buttons[k].classList.toggle('on', buttons[k].dataset.tab === list.tab);
  }
  /* The scope belongs to 帖子 alone: it says what THAT column means, and under
     回复 or 媒体 it would be a control for something it does not control. */
  el.scope.hidden = list.tab !== 'posts';
  el.scope.value = list.scope;
}

/* ------------------------------------------------------- open archives -- */

/**
 * Repaint everything that says which archives are open.
 *
 * The one entry point, called from BOTH armEmptyView() and commitSources() —
 * and that is not tidiness. Closing the LAST archive goes through the first of
 * those and not through the second, so anything painted only from
 * commitSources() would go on offering an account that is no longer open. That
 * exact bug has been fixed here once already, which is why there is one
 * function rather than two.
 *
 * It also re-reads the address, which is the other half of the same problem:
 * `clearIndexState()` drops the account filter whenever the source set changes,
 * because the record indices it was made of belong to a list that no longer
 * exists — and by the time this runs, the new list does, and the address still
 * says which account it wants. `applyAddress(true)` is that second reading; it
 * is forced because the address has not moved but its meaning has.
 */
function renderAccounts() {
  /* The sidebar button says what pressing it does: with a file already open it
     adds rather than replaces, so it stops saying 打开. */
  if (el.pickLabel) {
    el.pickLabel.textContent = archive.sources.length > 0 ? '添加归档' : '打开归档';
  }
  paintAccounts();
  refreshMe();
  applyAddress(true);
}

/**
 * The sidebar's list of accounts.
 *
 * One row per account rather than per file — the same grouping the 我 page and
 * 合并导出 use, so the three can never disagree about who is here.
 *
 * A row is a LINK to `#/@handle` and not a click handler, so that the browser's
 * own affordances work: middle-click, copy the address, see where it goes. An
 * account with no handle has no address, and gets a plain row instead — there
 * is nothing honest to link to.
 *
 * Every value goes in through textContent. A file name and a handle are both
 * things somebody else chose.
 */
function paintAccounts() {
  if (!el.sideAccts) return;
  el.sideAccts.textContent = '';
  var groups = groupSourcesByAccount();
  if (groups.length === 0) return;

  var head = document.createElement('div');
  head.className = 'side__head';
  head.textContent = '账号';
  el.sideAccts.appendChild(head);

  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    var h = groupHandle(g);
    var nm = groupName(g);
    var row = document.createElement(h === null ? 'span' : 'a');
    row.className = 'side__acct' + (g.key === activeAccount ? ' on' : '');
    if (h !== null) row.href = hrefOf({ name: 'account', handle: h });
    row.title = h === null ? g.sources.map(function (k) {
      return archive.sources[k].file.name;
    }).join(' + ') : '@' + h;
    row.appendChild(document.createTextNode(nm || (h === null ? row.title : '@' + h)));

    var n = document.createElement('span');
    n.textContent = ' ' + fmtCount(groupRecordCount(g));
    row.appendChild(n);
    el.sideAccts.appendChild(row);
  }
}


/* ------------------------------------------------------------- profile -- */

/** A string field as written, or ''. Every key here may be missing or mistyped:
    the envelope may have been hand-edited, merged, or written by a version that
    spelled the field differently. */
function asText(v) {
  return typeof v === 'string' ? v : '';
}

/** A count as a number, or null. Negative and non-finite values are refused
    rather than rendered: "-3 关注者" is a broken file talking. */
function asNum(v) {
  return typeof v === 'number' && isFinite(v) && v >= 0 ? v : null;
}

/** `2026年3月加入` — the month is the DISPLAY zone's month, not UTC's. */
function fmtJoin(iso) {
  var ms = Date.parse(iso);
  if (!isFinite(ms)) return '';
  var d = zoneDate(ms);
  return d.getUTCFullYear() + '年' + (d.getUTCMonth() + 1) + '月加入';
}

/** A stored URL as it should read in one line: host and path, no scheme, cut
    before it can wrap. The full address stays on the element as its title. */
function shortUrl(href) {
  var s = href;
  try {
    var u = new URL(href);
    s = u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname) + (u.search || '');
  } catch (_) { s = href; }
  return s.length > 42 ? s.slice(0, 41) + '…' : s;
}

/**
 * The meta line: where they are, what they linked to, when they joined.
 *
 * Only what the file holds appears. A placeholder for a missing field would be a
 * line of dots with nothing in it, and an empty profile is worth less than a
 * short one.
 */
function buildProfileMeta(p) {
  var items = [];
  var loc = asText(p.location);
  if (loc) {
    var l = span('pf__loc', loc);
    /* Only when it is long enough to be clamped by .pf__loc's two lines — a
       tooltip that repeats the short text next to it is noise. */
    if (loc.length > 40) l.title = loc;
    items.push(l);
  }
  var site = safeExternalUrl(asText(p.websiteUrl));
  if (site) {
    var a = document.createElement('a');
    a.href = site;                 /* a variable, never a literal in the markup */
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = shortUrl(site);
    a.title = site;
    items.push(a);
  }
  var joined = fmtJoin(asText(p.accountCreatedAt));
  if (joined) items.push(span('pf__join', joined));

  /* A locked account is a fact about every piece of it, so it goes in the line
     of facts rather than beside the name. Only when the capture actually said
     so: `protected` is null on anything written before this field existed, and
     an absent answer must not be drawn as an open account. */
  if (p.protected === true) items.push(span('pf__lock', '🔒 已锁定'));

  /* The post the account pinned. The archive usually holds that record — it is
     the first thing on the account's own timeline — so this links to it through
     the same route a card uses, and the route already knows what to say when
     the id is not in the file. An id nobody can follow would be noise. */
  var pinned = asText(p.pinnedTweetId);
  if (pinned) {
    var pin = document.createElement('a');
    pin.className = 'pf__pin';
    pin.textContent = '📌 置顶';
    pin.href = hrefOf({ name: 'post', handle: asText(p.screenName), id: pinned });
    pin.title = '打开这条置顶推文（不在归档里的话会说一声）';
    items.push(pin);
  }

  if (!items.length) return null;
  var line = document.createElement('div');
  line.className = 'pf__meta';
  for (var k = 0; k < items.length; k++) {
    if (k) line.appendChild(span('pf__dot', '·'));
    line.appendChild(items[k]);
  }
  return line;
}

/**
 * Following and followers, as X writes them in Chinese.
 *
 * Omitting a count the file does not carry, rather than showing a zero: a header
 * that says 0 关注者 about an account with followers is a wrong number, while no
 * number is merely an absent one. The exact figure is on the element as a title,
 * because fmtCount rounds — 12K for 12 345.
 */
function buildProfileCounts(p) {
  var following = asNum(p.followingCount);
  var followers = asNum(p.followersCount);
  /* The account's own total, which every source of a profile carries — the
     live capture reads it off the user node and an archived payload has it in
     `public_metrics` — and which this line used to leave out, while the comment
     below insisted it was here. It is the one number on the header that says
     how much of the account the archive is a window onto.
     Last, because 正在关注 and 关注者 are a pair and this is not one of them. */
  var posted = asNum(p.tweetCount);
  if (following === null && followers === null && posted === null) return null;

  var line = document.createElement('div');
  line.className = 'pf__counts';
  /* Clickable only when there is a list behind them. The profile card's counts
     come from the account's own figures; the rows come from the roster, and an
     archive can have one without the other — a card captured before the roster
     switch was ever turned on. A number that opens an empty room is worse than
     a number that is plainly just a number. */
  var openable = rosterAvailable();
  if (following !== null) line.appendChild(countBit(following, '正在关注', openable, 'following'));
  if (followers !== null) line.appendChild(countBit(followers, '关注者', openable, 'followers'));
  /* Never a button: the roster is a list of people, and there is no list of the
     account's posts to open — the timeline is already below. */
  if (posted !== null) line.appendChild(countBit(posted, '帖子', false, null));

  /* The three the profile carries that X's own header does not draw. Shown
     because the point of an archive is that it holds what the original does
     not keep on screen — and each is a real fact about the account rather than
     a derived number. Absent ones are simply not drawn. */
  var media = asNum(p.mediaCount);
  if (media !== null) line.appendChild(countBit(media, '媒体', false, null));
  var likes = asNum(p.likeCount);
  if (likes !== null) line.appendChild(countBit(likes, '喜欢', false, null));
  var listed = asNum(p.listedCount);
  if (listed !== null) line.appendChild(countBit(listed, '上列表', false, null));
  return line;
}

function countBit(value, label, openable, list) {
  var item = document.createElement(openable === true ? 'button' : 'span');
  item.className = openable === true ? 'pf__count pf__count--link' : 'pf__count';
  if (openable === true) {
    item.type = 'button';
    item.title = '打开' + label + '名单';
    item.addEventListener('click', function () { void openRoster(list); });
  }
  var b = document.createElement('b');
  b.textContent = fmtCount(value);
  b.title = String(value);
  item.appendChild(b);
  item.appendChild(document.createTextNode(' ' + label));
  return item;
}

/**
 * Put the real banner behind the header, when there is one to put there.
 *
 * Gated on the same switch as the avatars, and for the same reason: `bannerUrl`
 * is a pbs.twimg.com address, so fetching it tells X's CDN that this archive is
 * being read and roughly when. Off, the strip keeps the theme's flat grey —
 * which is what X itself draws for an account that never set a banner, so the
 * default state is a faithful one rather than a placeholder.
 *
 * The URL is only ever a variable. Nothing here builds markup, so there is no
 * `src=` for a literal to sit beside, and a URL that no longer resolves leaves
 * the grey underneath rather than a broken frame.
 */
function applyBannerImage(banner, p) {
  if (!prefs.remoteAvatars) return;
  var url = remoteMediaUrl(asText(p.bannerUrl));
  if (!url) return;
  banner.style.backgroundImage = 'url("' + url + '")';
}

/**
 * The account header, from the envelope's profile object.
 *
 * Every value goes in through textContent — no escaping step to forget, the same
 * rule the cards follow. The one exception is the verified badge, whose SVG is a
 * constant in this file and not data from the archive.
 *
 * Geometry follows X's own, measured at its 600px column rather than eyeballed:
 * banner 598x199, avatar 142 straddling the banner's bottom edge, name 20/800,
 * handle and meta at 15. See the .pf__ rules in the stylesheet.
 *
 * Returns false when there is nothing to show, and then the element is hidden
 * rather than left empty. An empty box above the timeline reads as a broken
 * header; the caller has a sentence that says what actually happened.
 */
function renderProfile(raw) {
  var p = raw && typeof raw === 'object' ? raw : null;
  el.profile.textContent = '';
  el.profile.hidden = true;
  /* The bar belongs to the header: no header, no bar. Leaving it up would put
     a name above a timeline that has no account behind it. */
  el.stickyBar.hidden = true;
  if (!p) return false;

  var name = asText(p.name);
  var handle = asText(p.screenName);
  if (!name && !handle) return false;

  /* Straight into #profile. There was a wrapper here while the header's height
     and its contents were driven separately; now that the header is ordinary
     content in the scroller, a wrapper would only be a node between the box and
     its children. */
  var banner = document.createElement('div');
  banner.className = 'pf__banner';
  applyBannerImage(banner, p);
  el.profile.appendChild(banner);

  var body = document.createElement('div');
  body.className = 'pf__body';

  /* The avatar sits ABOVE the name and straddles the banner's bottom edge,
     which is X's arrangement and the reason this header stops reading as flat.
     It is sized by the stylesheet — the third argument to avatarNode — so the
     collapsed state can shrink it to 36px; an inline width would beat any rule
     in the file. */
  var head = document.createElement('div');
  head.className = 'pf__head';
  /* Through the same node the cards use, which is what gives the header the
     letter-disc default and the `prefs.remoteAvatars` opt-in gate without
     either of them being re-implemented here. */
  var av = avatarNode({
    id: typeof p.userId === 'number' ? String(p.userId) : asText(p.userId),
    screenName: handle,
    name: name,
    avatarUrl: asText(p.avatarUrl),
    /* The picture the extension cached and the export inlined. Empty for every
       archive written before this existed, which is what makes it a fallback
       rather than a requirement. */
    avatarData: asText(p.avatarData)
  }, 142, true);
  av.classList.add('pf__avatar');
  head.appendChild(av);

  var id = document.createElement('div');
  id.className = 'pf__id';
  var names = document.createElement('div');
  names.className = 'pf__names';
  names.appendChild(span('pf__name', name || handle));
  if (p.blueVerified === true) {
    /* innerHTML from a constant, never from the record: this is X's SVG copied
       out of the live page, and nothing in the file can reach it. */
    var check = span('card__verified');
    check.innerHTML = verifiedIcon();
    check.title = 'X 认证（捕获时）';
    names.appendChild(check);
  }
  id.appendChild(names);
  /* The handle is PLAIN TEXT, not a link — the same rule the post text follows.
     The account may be gone, and following @someone out of an archive would
     leave the archive to land nowhere. */
  if (handle) id.appendChild(span('pf__handle', '@' + handle));
  head.appendChild(id);
  body.appendChild(head);

  var bio = renderBio(p);
  if (bio) {
    var bp = document.createElement('p');
    bp.className = 'pf__bio';
    bp.appendChild(bio);
    /* The element is clamped to four lines, and the clamp is invisible — so the
       whole text, with its newlines, is one hover away. */
    bp.title = asText(p.bio);
    body.appendChild(bp);
  }
  var meta = buildProfileMeta(p);
  if (meta) body.appendChild(meta);
  var counts = buildProfileCounts(p);
  if (counts) body.appendChild(counts);

  el.profile.appendChild(body);
  el.profile.hidden = false;

  /* The bar the header scrolls away into: the name and a post count, which is
     what X keeps and all it keeps.
   *
   * The number is how many records are in THIS FILE, not the account's
   * `tweetCount`. X shows the account's total because on X the timeline is the
   * account; here the file is all there is, and a bar reading "1.3K 帖子" above
   * a timeline of thirty is a number about somewhere else. The account's own
   * figure is on the header below, in the counts line — so both numbers are on
   * screen at once and they mean different things.「本档」is what keeps them
   * apart: without it the bar and the header both say "1.0K 帖子" about two
   * different quantities, and the reader has no way to tell which one moved. */
  el.sbName.textContent = name || handle || '';
  el.sbCount.textContent = '本档 ' + fmtCount(archive.ranges.length) + ' 帖子';
  el.stickyBar.hidden = false;
  return true;
}

/**
 * The header for a merged view of several accounts.
 *
 * Two different accounts open together have no single card that is true, but
 * they do have an answer worth drawing: the faces and the handles that are
 * open, and how much is behind them. Before this, that case drew nothing at
 * all — the area above the timeline was simply empty, with a line in the report
 * explaining why. An explanation is not a header.
 *
 * No banner and no 142px face on purpose — see the `.pf__multi` comment. What
 * is here is the same information a header carries, minus the claim that it
 * belongs to one person.
 */
function renderAccountList(list) {
  /* Two or more, and no fewer. One account whose card could not be drawn is a
     broken profile rather than a list, and "1 个账号" over it would be a header
     answering a question nobody asked — the caller's notice says what actually
     happened to that file. */
  if (!Array.isArray(list) || list.length < 2) return false;

  var body = document.createElement('div');
  body.className = 'pf__body pf__multi';

  var faces = document.createElement('div');
  faces.className = 'pf__faces';
  /* Every face would be a request for anybody who has opened a dozen archives,
     and past the first handful the row has stopped being readable anyway. */
  var shown = Math.min(list.length, 8);
  for (var i = 0; i < shown; i++) {
    var wrap = document.createElement('span');
    wrap.className = 'pf__face';
    wrap.appendChild(avatarNode({
      id: typeof list[i].userId === 'number' ? String(list[i].userId) : asText(list[i].userId),
      screenName: asText(list[i].screenName),
      name: asText(list[i].name),
      avatarUrl: asText(list[i].avatarUrl),
      avatarData: asText(list[i].avatarData)
    }, 48, true));
    faces.appendChild(wrap);
  }
  if (list.length > shown) {
    var more = document.createElement('span');
    more.className = 'pf__more';
    more.textContent = '还有 ' + (list.length - shown) + ' 个';
    faces.appendChild(more);
  }
  body.appendChild(faces);

  var id = document.createElement('div');
  id.className = 'pf__id';
  var names = document.createElement('div');
  names.className = 'pf__names';
  names.appendChild(span('pf__name', list.length + ' 个账号'));
  id.appendChild(names);

  /* The handles, in the order the files were opened, capped so one enormous set
     cannot turn the header into a wall. Each is PLAIN TEXT, the same rule the
     post text and the single header's handle follow. */
  var handles = [];
  for (var h = 0; h < list.length && handles.length < 6; h++) {
    var handle = asText(list[h].screenName);
    if (handle) handles.push('@' + handle);
  }
  if (handles.length > 0) {
    id.appendChild(span('pf__handle', handles.join(' · ') +
      (list.length > handles.length ? ' 等 ' + list.length + ' 个' : '')));
  }
  body.appendChild(id);

  var counts = document.createElement('div');
  counts.className = 'pf__counts';
  var n = document.createElement('span');
  n.className = 'pf__count';
  var nb = document.createElement('b');
  nb.textContent = fmtCount(archive.ranges.length);
  n.appendChild(nb);
  n.appendChild(document.createTextNode(' 条推文'));
  counts.appendChild(n);
  body.appendChild(counts);

  el.profile.appendChild(body);
  el.profile.hidden = false;

  el.sbName.textContent = list.length + ' 个账号';
  el.sbCount.textContent = '本档 ' + fmtCount(archive.ranges.length) + ' 帖子';
  el.stickyBar.hidden = false;
  return true;
}
