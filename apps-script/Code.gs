/**
 * 올케어에듀 · 과학 학습현황 (권일준 선생님반 주간테스트)  v1  2026-10-25
 *
 * 학생은 개인 링크에서 주간테스트 답(①~⑤)을 입력 → 바로 채점.
 * 학생 · 학부모 · 강사 화면, 단원 보완 리포트, 같은 개념 반복 오답 경고,
 * 회차별 · 기간별 오답 시험지(인쇄 → PDF)를 제공합니다.
 *
 * 데이터 흐름
 *   · 시험지(문항 그림 · 정답 · 개념)  : 드라이브 「과학/00 학습현황/시험/{시험ID}/」 ← 매주 Claude 예약 작업이 등록
 *   · 토요일 마감 리포트              : 「…/리포트/{시험ID}.json」                  ← 일요일 00:05 Claude 예약 작업
 *   · 클래스카드 이관 기록             : 「…/원본데이터/classcard_*.json」
 *   이 웹앱이 10분마다 폴더를 읽어 DB 시트에 반영합니다(syncIfChanged).
 *
 * ■ 처음 한 번: setup 실행 → 웹앱 배포(실행: 나, 액세스: 모든 사용자) → /exec 주소를 WEBAPP_URL에 → 저장
 *               → makeLinks 실행 → [배포 관리]에서 새 버전
 * ■ 고친 뒤에는 새 배포를 만들지 말고 [배포 관리] → 수정 → 새 버전 (주소 유지). setup 다시 돌리지 않기.
 * ■ KEY(관리용 비밀값)는 스크립트 속성에만 있습니다. 코드에는 넣지 않습니다.
 */
var APP = '과학 학습현황';
var TEACHER = '권일준';
var TZ = 'Asia/Seoul';
var BRAND = '#4E3629';                                        // 과목색: 과학 브라운
var LOGO_URL = 'https://allcare-edu.github.io/logo.png?v=3';
var PUBLIC_URL = 'https://allcare-edu.github.io/science/';    // 카톡에 보내는 주소(공개 화면)
var WEBAPP_URL = '';                                          // 배포 후 /exec 주소
var DATA_FOLDER_ID = '';                                      // 「과학/00 학습현황」 폴더 ID
var DB_TITLE = '올케어 과학 학습현황 DB (권일준반)';
var SHARE_WITH = ['ymkeng@gmail.com'];                        // DB 시트를 함께 쓰는 계정(예약 작업)
var GRADE_OF = { '고1A': '고1', '고1B': '고1', '중3': '중3' };
var CLASS_ORDER = ['고1A', '고1B', '중3'];
var ROSTER_DEFAULT = [];                                      // [['반','이름'], …] — 설치할 때만 채움(공개 저장소에는 학생 이름을 두지 않음)
var TEACHERS_DEFAULT = [['권일준 선생님', '강사'], ['원장', '원장']];
var WRONG_SHEET_MAX = 60;                                     // 기간별 오답지 최대 문항

var H = {
  명단: ['반', '이름', '학년', '상태', '클래스카드이름', '학생코드', '학부모코드', '학생링크', '학부모링크', '메모'],
  강사: ['이름', '역할', '코드', '링크', '상태'],
  시험: ['시험ID', '학년', '수업일', '마감', '제목', '문항수', '정답', '단원', '폴더ID', '등록시각', '상태'],
  문항: ['시험ID', '번호', '정답', '개념1', '개념2', '문항그림', '해설그림', '해설'],
  개념: ['학년', '단원', '개념', '핵심정리'],
  응시: ['제출시각', '시험ID', '학년', '반', '이름', '답안', '점수', '맞은수', '문항수', '틀린번호', '출처', '상태'],
  리포트: ['작성시각', '시험ID', '대상', '반', '이름', '내용'],
  기록: ['시각', '내용']
};

// ───────────────────────────── 설치 ─────────────────────────────
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('DB_ID')) { Logger.log('이미 설치됨: ' + db_().getUrl()); return; }
  var ss = SpreadsheetApp.create(DB_TITLE);
  ss.setSpreadsheetTimeZone(TZ);
  if (DATA_FOLDER_ID) { try { DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(DATA_FOLDER_ID)); } catch (e) { Logger.log('폴더 이동 실패: ' + e); } }
  ss.getSheets()[0].setName('명단');
  props.setProperty('DB_ID', ss.getId());
  if (!props.getProperty('KEY')) props.setProperty('KEY', Utilities.getUuid().replace(/-/g, '').slice(0, 26));
  writeTab_(ss, '명단', H.명단, ROSTER_DEFAULT.map(function (r) { return [r[0], r[1], GRADE_OF[r[0]], '재원', '', '', '', '', '', '']; }));
  writeTab_(ss, '강사', H.강사, TEACHERS_DEFAULT.map(function (r) { return [r[0], r[1], '', '', '사용']; }));
  ['시험', '문항', '개념', '응시', '리포트', '기록'].forEach(function (t) { writeTab_(ss, t, H[t], []); });
  writeGuide_(ss);
  SHARE_WITH.forEach(function (m) { try { ss.addEditor(m); } catch (e) { Logger.log('공유 실패 ' + m + ': ' + e); } });
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncIfChanged').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('onOpenMenu').forSpreadsheet(ss).onOpen().create();
  Logger.log('DB 시트: ' + ss.getUrl());
  Logger.log('KEY: ' + props.getProperty('KEY'));
}

function onOpenMenu() {
  SpreadsheetApp.getActive().addMenu('과학 학습현황', [
    { name: '폴더 지금 반영', functionName: 'syncNow' },
    { name: '새 학생 링크 만들기', functionName: 'makeLinks' }
  ]);
}

function writeGuide_(ss) {
  var sh = ss.getSheetByName('안내') || ss.insertSheet('안내', 0);
  sh.clear();
  var rows = [
    [DB_TITLE, ''],
    ['명단', '반·이름·상태(재원/퇴원). 새 학생은 한 줄 넣고 메뉴 [과학 학습현황] → [새 학생 링크 만들기]. 퇴원은 상태를 \'퇴원\'으로 (링크가 막힘).'],
    ['시험·문항·개념', '드라이브 「과학/00 학습현황/시험」 폴더에서 10분마다 자동으로 들어옵니다. 직접 고치지 마세요.'],
    ['응시', '학생이 링크에서 제출한 답. 상태를 \'재응시허용\'으로 바꾸면 그 학생이 다시 낼 수 있습니다(강사 화면 버튼과 같음).'],
    ['리포트', '토요일 자정 마감 후 Claude 예약 작업이 쓴 보완 리포트(학생·학부모·반).'],
    ['마감', '수업일(일요일) + 6일, 토요일 23:59. 그 뒤 제출은 \'지각\'으로 표시됩니다.']
  ];
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sh.setColumnWidth(1, 140); sh.setColumnWidth(2, 720);
}

// ───────────────────────────── 시트 도구 ─────────────────────────────
function db_() { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('DB_ID')); }
function key_() { return PropertiesService.getScriptProperties().getProperty('KEY'); }
var _DB = null;
function dbc_() { return _DB || (_DB = db_()); }
function tab_(name) {
  var ss = dbc_(), sh = ss.getSheetByName(name);
  if (!sh) { writeTab_(ss, name, H[name], []); sh = ss.getSheetByName(name); }
  return sh;
}
var _ROWS = {};
function rows_(name) {
  if (_ROWS[name]) return _ROWS[name];
  var sh = tab_(name), n = sh.getLastRow();
  var v = n < 2 ? [] : sh.getRange(2, 1, n - 1, H[name].length).getValues();
  return (_ROWS[name] = v);
}
function dirty_(name) { delete _ROWS[name]; }
function writeTab_(ss, name, head, rows) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground(BRAND).setFontColor('#ffffff');
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  sh.setFrozenRows(1);
  dirty_(name);
  return sh;
}
function append_(name, rows) {
  if (!rows.length) return;
  var sh = tab_(name);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, H[name].length).setValues(rows);
  dirty_(name);
}
function log_(msg) { try { append_('기록', [[now_(), String(msg).slice(0, 4000)]]); } catch (e) {} }
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function ymd_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}
function ymdhms_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
  return String(v || '');
}
function addDays_(ymd, n) {
  var p = ymd.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + n * 864e5);
  return d.toISOString().slice(0, 10);
}
function md_(ymd) { var p = String(ymd).split('-'); return (+p[1]) + '/' + (+p[2]); }
function esc_(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function circ_(d) { return '①②③④⑤'.charAt(+d - 1) || String(d); }
function ansTxt_(a) { a = String(a || ''); return a ? a.split('').map(circ_).join('') : '·'; }

// ───────────────────────────── 드라이브 폴더 → DB ─────────────────────────────
function syncIfChanged() { sync_(false); }
function syncNow() { var r = sync_(true); Logger.log(JSON.stringify(r)); return r; }

function sync_(force) {
  if (!DATA_FOLDER_ID) return { ok: false, err: 'DATA_FOLDER_ID 없음' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, err: 'busy' };
  var props = PropertiesService.getScriptProperties(), out = { tests: [], reports: [], imports: [], concepts: 0 };
  try {
    var root = DriveApp.getFolderById(DATA_FOLDER_ID);
    // 1) 개념
    var cf = sub_(root, '개념'), cfs = cf.getFiles(), cstamp = [];
    var cfiles = [];
    while (cfs.hasNext()) { var f = cfs.next(); if (/\.json$/i.test(f.getName())) { cfiles.push(f); cstamp.push(f.getName() + f.getLastUpdated().getTime()); } }
    var csig = cstamp.sort().join('|');
    if (force || csig !== props.getProperty('SIG_CONCEPTS')) {
      var crows = [];
      cfiles.forEach(function (f) {
        var g = (f.getName().match(/_(고\d|중\d)/) || [])[1] || '';
        var j = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
        Object.keys(j).forEach(function (unit) { Object.keys(j[unit]).forEach(function (c) { crows.push([g, unit, c, j[unit][c]]); }); });
      });
      writeTab_(dbc_(), '개념', H.개념, crows); out.concepts = crows.length;
      props.setProperty('SIG_CONCEPTS', csig);
    }
    // 2) 시험 — 「시험/{시험ID}.zip」이 올라오면 풀어서 「시험/{시험ID}/」 폴더로 (예전 폴더는 이름 뒤에 _old_시각)
    var tdir = sub_(root, '시험');
    unzipTests_(tdir, out);
    var tf = tdir.getFolders();
    while (tf.hasNext()) {
      var folder = tf.next();
      if (/_old_/.test(folder.getName())) continue;
      var tj = first_(folder, 'test.json');
      if (!tj) continue;
      var tg = first_(folder, 'tags.json');
      var sig = tj.getLastUpdated().getTime() + '/' + (tg ? tg.getLastUpdated().getTime() : 0);
      var pk = 'SIG_T_' + folder.getId();
      if (!force && props.getProperty(pk) === sig) continue;
      registerTest_(folder, tj, tg);
      props.setProperty(pk, sig); out.tests.push(folder.getName());
    }
    // 3) 리포트
    var rf = sub_(root, '리포트').getFiles();
    while (rf.hasNext()) {
      var r = rf.next(); if (!/\.json$/i.test(r.getName())) continue;
      var rk = 'SIG_R_' + r.getId(), rs = String(r.getLastUpdated().getTime());
      if (!force && props.getProperty(rk) === rs) continue;
      importReport_(JSON.parse(r.getBlob().getDataAsString('UTF-8')));
      props.setProperty(rk, rs); out.reports.push(r.getName());
    }
    // 4) 클래스카드 등 외부 응시 기록
    var imf = sub_(root, '원본데이터').getFiles();
    while (imf.hasNext()) {
      var im = imf.next(); if (!/\.json$/i.test(im.getName())) continue;
      var ik = 'SIG_I_' + im.getId(), is = String(im.getLastUpdated().getTime());
      if (!force && props.getProperty(ik) === is) continue;
      out.imports.push(im.getName() + ':' + importResponses_(JSON.parse(im.getBlob().getDataAsString('UTF-8'))));
      props.setProperty(ik, is);
    }
    if (out.tests.length || out.reports.length || out.imports.length || out.concepts) log_('동기화 ' + JSON.stringify(out));
    CacheService.getScriptCache().remove('TESTS');
    return { ok: true, r: out };
  } catch (e) {
    log_('동기화 실패: ' + e); return { ok: false, err: String(e) };
  } finally { lock.releaseLock(); }
}
function unzipTests_(tdir, out) {
  var zs = tdir.getFiles();
  while (zs.hasNext()) {
    var z = zs.next(), m = z.getName().match(/^(.+)\.zip$/i);
    if (!m) continue;
    var id = m[1], blobs = Utilities.unzip(z.getBlob());
    var old = tdir.getFoldersByName(id);
    while (old.hasNext()) old.next().setName(id + '_old_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMddHHmmss'));
    var nf = tdir.createFolder(id);
    blobs.forEach(function (b) { var n = String(b.getName()).split('/').pop(); if (n) nf.createFile(b.setName(n)); });
    z.setName(z.getName() + '.done');
    out.unzipped = (out.unzipped || []).concat([id + ':' + blobs.length]);
  }
}
function sub_(folder, name) { var it = folder.getFoldersByName(name); return it.hasNext() ? it.next() : folder.createFolder(name); }
function first_(folder, name) { var it = folder.getFilesByName(name); return it.hasNext() ? it.next() : null; }

function registerTest_(folder, tj, tg) {
  var t = JSON.parse(tj.getBlob().getDataAsString('UTF-8'));
  var tags = tg ? JSON.parse(tg.getBlob().getDataAsString('UTF-8')) : { unit: '', q: {} };
  var files = {}, it = folder.getFiles();
  while (it.hasNext()) { var f = it.next(); files[f.getName()] = f.getId(); }
  var key = t.questions.map(function (q) { return q.ans.join(''); }).join(',');
  var deadline = addDays_(t.date, 6);
  var trow = [t.id, t.grade, t.date, deadline, t.title || (md_(t.date) + ' 주간테스트'), t.n, key, tags.unit || '', folder.getId(), now_(), '공개'];
  var tests = rows_('시험').filter(function (r) { return r[0] !== t.id; });
  tests.push(trow);
  tests.sort(function (a, b) { return ymd_(a[2]) < ymd_(b[2]) ? -1 : ymd_(a[2]) > ymd_(b[2]) ? 1 : String(a[1]) < String(b[1]) ? -1 : 1; });
  writeTab_(dbc_(), '시험', H.시험, tests);
  var qs = rows_('문항').filter(function (r) { return r[0] !== t.id; });
  t.questions.forEach(function (q) {
    var c = (tags.q && tags.q[String(q.no)]) || [];
    qs.push([t.id, q.no, q.ans.join(''), c[0] || '', c[1] || '', files[q.img] || '', files[q.eimg] || '', String(q.exp || '').slice(0, 3000)]);
  });
  writeTab_(dbc_(), '문항', H.문항, qs);
  // 이미 들어온 응시 기록 재채점(정답이 고쳐졌을 수 있음)
  regrade_(t.id);
}

function importReport_(j) {
  // { test: '고1-1018', items: [ {target:'학생'|'학부모'|'반', cls:'고1A', name:'홍길동', text:'…'} ] }
  var keep = rows_('리포트').filter(function (r) { return r[1] !== j.test; });
  var at = j.at || now_();
  (j.items || []).forEach(function (x) { keep.push([at, j.test, x.target, x.cls || '', x.name || '', String(x.text || '').slice(0, 45000)]); });
  writeTab_(dbc_(), '리포트', H.리포트, keep);
}

function importResponses_(j) {
  // { source:'클래스카드', items:[ {test, name, answers:'2,5,15,…', at:'2026-10-21 20:11'} ] }
  var roster = roster_(), have = {}, add = [];
  rows_('응시').forEach(function (r) { have[r[1] + '|' + r[4] + '|' + r[10]] = 1; });
  (j.items || []).forEach(function (x) {
    var st = roster.filter(function (s) { return s.name === x.name; })[0];
    if (!st) return;
    var k = x.test + '|' + x.name + '|' + (j.source || '이관');
    if (have[k]) return;
    var g = grade_(x.test, String(x.answers).split(','));
    if (!g) return;
    add.push([x.at || now_(), x.test, st.grade, st.cls, st.name, g.answers.join(','), g.score, g.right, g.n, g.wrong.join(','), j.source || '이관', '유효']);
    have[k] = 1;
  });
  append_('응시', add);
  return add.length;
}

// ───────────────────────────── 명단 · 링크 ─────────────────────────────
function roster_() {
  return rows_('명단').filter(function (r) { return r[1] && String(r[3]).trim() !== '퇴원' && String(r[3]).trim() !== '제외'; })
    .map(function (r) { return { cls: String(r[0]), name: String(r[1]), grade: String(r[2] || GRADE_OF[r[0]] || ''), scode: String(r[5]), pcode: String(r[6]) }; });
}
function who_(kind, code) {
  code = String(code || '').trim();
  if (!code || code.length < 6) return null;
  if (kind === '강사') {
    var t = rows_('강사').filter(function (r) { return String(r[2]) === code && r[4] === '사용'; })[0];
    return t ? { kind: '강사', name: String(t[0]), role: String(t[1]) } : null;
  }
  var col = kind === '학생' ? 5 : 6;
  var r = rows_('명단').filter(function (x) { return String(x[col]) === code; })[0];
  if (!r || String(r[3]).trim() === '퇴원' || String(r[3]).trim() === '제외') return null;
  return { kind: kind, cls: String(r[0]), name: String(r[1]), grade: String(r[2] || GRADE_OF[r[0]]), code: code };
}
function newCode_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function shortUrl_(url) {
  try {
    var r = UrlFetchApp.fetch('https://da.gd/s?url=' + encodeURIComponent(url), { muteHttpExceptions: true });
    var t = r.getContentText().trim();
    if (r.getResponseCode() === 200 && /^https:\/\/da\.gd\//.test(t)) return t;
  } catch (e) {}
  return url;
}
function makeLinks() {
  var sh = tab_('명단'), v = rows_('명단'), base = PUBLIC_URL || WEBAPP_URL, n = 0;
  v.forEach(function (r, i) {
    if (!r[1]) return;
    if (!r[2]) r[2] = GRADE_OF[r[0]] || '';
    if (!r[5]) { r[5] = newCode_(); r[7] = ''; }
    if (!r[6]) { r[6] = newCode_(); r[8] = ''; }
    if (!r[7]) { r[7] = shortUrl_(base + '?s=' + r[5]); n++; }
    if (!r[8]) { r[8] = shortUrl_(base + '?p=' + r[6]); n++; }
  });
  if (v.length) sh.getRange(2, 1, v.length, H.명단.length).setValues(v);
  var th = tab_('강사'), tv = rows_('강사');
  tv.forEach(function (r) { if (!r[2]) r[2] = newCode_(); if (!r[3]) r[3] = shortUrl_(base + '?a=' + r[2]); });
  if (tv.length) th.getRange(2, 1, tv.length, H.강사.length).setValues(tv);
  dirty_('명단'); dirty_('강사');
  Logger.log('링크 ' + n + '개 새로 만듦');
}
function resetLink(name) {
  var sh = tab_('명단'), v = rows_('명단');
  v.forEach(function (r) { if (r[1] === name) { r[5] = ''; r[7] = ''; } });
  sh.getRange(2, 1, v.length, H.명단.length).setValues(v); dirty_('명단'); makeLinks();
}

// ───────────────────────────── 시험 · 채점 ─────────────────────────────
function tests_() {
  return rows_('시험').filter(function (r) { return r[0] && r[10] !== '숨김'; }).map(function (r) {
    return { id: String(r[0]), grade: String(r[1]), date: ymd_(r[2]), deadline: ymd_(r[3]), title: String(r[4]), n: +r[5],
             key: String(r[6]).split(','), unit: String(r[7]) };
  });
}
function test_(id) { return tests_().filter(function (t) { return t.id === id; })[0]; }
function questions_(id) {
  return rows_('문항').filter(function (r) { return r[0] === id; }).map(function (r) {
    return { no: +r[1], ans: String(r[2]), c1: String(r[3]), c2: String(r[4]), img: String(r[5]), eimg: String(r[6]), exp: String(r[7]) };
  }).sort(function (a, b) { return a.no - b.no; });
}
function closed_(t) { return today_() > t.deadline; }
function status_(t) {
  var d = today_();
  if (d > t.deadline) return '마감';
  return '진행';
}
function norm_(a) { return String(a || '').replace(/[^1-5]/g, '').split('').filter(function (c, i, s) { return s.indexOf(c) === i; }).sort().join(''); }
function grade_(testId, answers) {
  var t = test_(testId); if (!t) return null;
  var right = 0, wrong = [], ans = [];
  for (var i = 0; i < t.n; i++) {
    var a = norm_(answers[i]), k = norm_(t.key[i]);
    ans.push(a);
    if (a && a === k) right++; else wrong.push(i + 1);
  }
  return { n: t.n, right: right, wrong: wrong, answers: ans, score: Math.floor(right / t.n * 100 + 1e-9) };
}
function regrade_(testId) {
  var sh = tab_('응시'), v = rows_('응시'), ch = false;
  v.forEach(function (r) {
    if (r[1] !== testId) return;
    var g = grade_(testId, String(r[5]).split(',')); if (!g) return;
    if (g.score !== +r[6] || g.wrong.join(',') !== String(r[9])) { r[6] = g.score; r[7] = g.right; r[8] = g.n; r[9] = g.wrong.join(','); ch = true; }
  });
  if (ch) { sh.getRange(2, 1, v.length, H.응시.length).setValues(v); dirty_('응시'); }
}
// 학생별 유효 응시(시험당 1개: 가장 먼저 낸 '유효/지각' 기록)
function subs_(filter) {
  var by = {};
  rows_('응시').forEach(function (r) {
    if (r[11] !== '유효' && r[11] !== '지각') return;
    if (filter && !filter(r)) return;
    var k = r[1] + '|' + r[4];
    if (!by[k] || ymdhms_(r[0]) < by[k].at) by[k] = { at: ymdhms_(r[0]), test: String(r[1]), grade: String(r[2]), cls: String(r[3]), name: String(r[4]),
      answers: String(r[5]).split(','), score: +r[6], right: +r[7], n: +r[8], wrong: String(r[9]) ? String(r[9]).split(',').map(Number) : [], src: String(r[10]), late: r[11] === '지각' };
  });
  return Object.keys(by).map(function (k) { return by[k]; });
}
function subOf_(name, testId) { return subs_(function (r) { return r[4] === name && r[1] === testId; })[0] || null; }

// 학생이 답안 제출
function apiSubmit(code, testId, answers) {
  var w = who_('학생', code); if (!w) throw new Error('링크가 올바르지 않습니다');
  var t = test_(testId); if (!t || t.grade !== w.grade) throw new Error('시험을 찾지 못했습니다');
  if (!answers || answers.length !== t.n) throw new Error('답안 수가 맞지 않습니다');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    dirty_('응시');
    var prev = rows_('응시').filter(function (r) { return r[1] === testId && r[4] === w.name && (r[11] === '유효' || r[11] === '지각'); });
    if (prev.length) throw new Error('이미 제출했습니다. 다시 내야 하면 선생님께 말씀드리세요.');
    var g = grade_(testId, answers);
    var late = today_() > t.deadline;
    append_('응시', [[now_(), testId, w.grade, w.cls, w.name, g.answers.join(','), g.score, g.right, g.n, g.wrong.join(','), '링크', late ? '지각' : '유효']]);
    return { score: g.score, right: g.right, n: g.n, wrong: g.wrong, late: late };
  } finally { lock.releaseLock(); }
}
// 강사: 재응시 허용
function apiReset(code, name, testId) {
  var w = who_('강사', code); if (!w) throw new Error('권한이 없습니다');
  var sh = tab_('응시'), v = rows_('응시'), n = 0;
  v.forEach(function (r) { if (r[1] === testId && r[4] === name && (r[11] === '유효' || r[11] === '지각')) { r[11] = '재응시허용'; n++; } });
  if (n) { sh.getRange(2, 1, v.length, H.응시.length).setValues(v); dirty_('응시'); }
  log_(w.name + ' 재응시 허용: ' + name + ' ' + testId);
  return n;
}

// ───────────────────────────── 분석 ─────────────────────────────
function tipMap_() {
  var m = {}; rows_('개념').forEach(function (r) { m[String(r[2])] = String(r[3]); }); return m;
}
// 한 학생의 시험별 결과 + 개념별 오답 + 반복 경고
function studentAnalysis_(name, grade) {
  var tests = tests_().filter(function (t) { return t.grade === grade; });
  var subs = subs_(function (r) { return r[4] === name; });
  var res = [];
  tests.forEach(function (t) {
    var s = subs.filter(function (x) { return x.test === t.id; })[0];
    var qs = questions_(t.id), missC = {}, hasC = {}, miss1 = {}, has1 = {};
    qs.forEach(function (q) {
      [q.c1, q.c2].forEach(function (c) { if (c) hasC[c] = (hasC[c] || 0) + 1; });
      if (q.c1) has1[q.c1] = 1;
      if (s && s.wrong.indexOf(q.no) >= 0) {
        [q.c1, q.c2].forEach(function (c) { if (c) (missC[c] = missC[c] || []).push(q.no); });
        if (q.c1) (miss1[q.c1] = miss1[q.c1] || []).push(q.no);
      }
    });
    res.push({ t: t, s: s, qs: qs, missC: missC, hasC: hasC, miss1: miss1, has1: has1 });
  });
  // 반복 오답: 개념 c를 틀린 시험 바로 앞(그 개념이 나온 이전 시험)에서도 c를 틀렸으면 경고
  var warns = [], lastSeen = {};
  res.forEach(function (x) {
    if (!x.s) return;
    // 반복 경고는 문항의 주 개념(개념1)만으로 판단(보조 개념까지 넣으면 경고가 너무 많아짐)
    Object.keys(x.has1).forEach(function (c) {
      var missed = !!x.miss1[c];
      var prev = lastSeen[c];
      if (missed && prev && prev.missed) warns.push({ c: c, now: x.t, prev: prev.t, nos: x.miss1[c], prevNos: prev.nos, streak: (prev.streak || 1) + 1 });
      lastSeen[c] = { t: x.t, missed: missed, nos: x.miss1[c] || [], streak: missed ? ((prev && prev.missed ? prev.streak || 1 : 0) + 1) : 0 };
    });
  });
  return { res: res, warns: warns };
}
function classStats_(testId) {
  var t = test_(testId), qs = questions_(testId);
  var roster = roster_().filter(function (s) { return s.grade === t.grade; });
  var subs = subs_(function (r) { return r[1] === testId; }).filter(function (s) { return roster.some(function (x) { return x.name === s.name; }); });
  var item = qs.map(function (q) { return { q: q, wrong: [], picks: {} }; });
  subs.forEach(function (s) {
    s.wrong.forEach(function (no) { if (item[no - 1]) item[no - 1].wrong.push(s.name); });
    s.answers.forEach(function (a, i) { if (item[i] && a !== item[i].q.ans) item[i].picks[a || '무응답'] = (item[i].picks[a || '무응답'] || 0) + 1; });
  });
  var cAgg = {};
  item.forEach(function (it) { [it.q.c1, it.q.c2].forEach(function (c) { if (!c) return; cAgg[c] = cAgg[c] || { c: c, slots: 0, miss: 0, students: {} };
    cAgg[c].slots += subs.length; cAgg[c].miss += it.wrong.length; it.wrong.forEach(function (n) { cAgg[c].students[n] = 1; }); }); });
  var scores = subs.map(function (s) { return s.score; });
  return { t: t, qs: qs, roster: roster, subs: subs, item: item,
    concepts: Object.keys(cAgg).map(function (k) { var a = cAgg[k]; a.rate = a.slots ? Math.round(a.miss / a.slots * 100) : 0; a.who = Object.keys(a.students); return a; })
      .sort(function (a, b) { return b.rate - a.rate; }),
    avg: scores.length ? Math.round(scores.reduce(function (a, b) { return a + b; }, 0) / scores.length) : null,
    max: scores.length ? Math.max.apply(null, scores) : null, min: scores.length ? Math.min.apply(null, scores) : null };
}
function reports_(testId, target, name) {
  return rows_('리포트').filter(function (r) { return r[1] === testId && r[2] === target && (!name || r[4] === name); }).map(function (r) { return String(r[5]); });
}

// ───────────────────────────── 웹 진입점 ─────────────────────────────
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.api) return api_(p);
  var pg = routePage_(p); if (pg) return pg;
  if (p.k && p.k === key_() && p.sync === '1') return json_(syncNow());
  return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">올케어에듀 과학 학습현황 · 학원에서 받은 개인 링크로 들어와 주세요.</p>');
}
function doPost(e) {
  var p = (e && e.parameter) || {}, body = {};
  try { body = JSON.parse(e.postData.contents); } catch (x) {}
  if (p.api) return api_(p, body);
  return json_({ ok: false, err: 'api' });
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function apiMap_() { return { apiSubmit: apiSubmit, apiReset: apiReset }; }
function api_(p, body) {
  var out;
  try {
    if (p.api === 'page') {
      var pg = routePage_(p) || deny_();
      out = { ok: true, title: pg.getTitle(), html: pg.getContent() };
    } else if (p.api === 'run') {
      var q = body && body.fn ? body : { fn: p.fn, args: JSON.parse(p.args || '[]') };
      var f = apiMap_()[q.fn]; if (!f) throw new Error('허용되지 않은 기능입니다');
      out = { ok: true, r: f.apply(null, q.args || []) };
    } else out = { ok: false, err: 'api' };
  } catch (x) { out = { ok: false, err: String((x && x.message) || x) }; }
  var s = JSON.stringify(out);
  if (p.cb && /^[A-Za-z_$][\w$]*$/.test(p.cb)) return ContentService.createTextOutput(p.cb + '(' + s + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}
function routePage_(p) {
  if (p.s && (p.w || p.from)) { var ws = who_('학생', p.s); return ws ? wrongSheetPage_(ws, p) : deny_(); }
  if (p.a && p.u && (p.w || p.from)) {
    var wa = who_('강사', p.a); if (!wa) return deny_();
    var st = roster_().filter(function (s) { return s.name === p.u; })[0]; return st ? wrongSheetPage_(st, p, true) : deny_();
  }
  if (p.s) { var w = who_('학생', p.s); return w ? page_('학생', studentHtml_(w, p)) : deny_(); }
  if (p.p) { var w2 = who_('학부모', p.p); return w2 ? page_('학부모', parentHtml_(w2, p)) : deny_(); }
  if (p.a) { var w3 = who_('강사', p.a); return w3 ? page_('강사', teacherHtml_(w3, p)) : deny_(); }
  return null;
}
function base_() { return PUBLIC_URL || WEBAPP_URL; }
function link_(q) { return base_() + '?' + q; }
function deny_() { return page_('', '<div class="card"><p>링크가 올바르지 않거나 사용이 중지되었습니다.<br>학원(010-4717-6373)으로 문의해 주세요.</p></div>'); }
function page_(kind, body, extraCss) {
  var html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' + CSS_ + (extraCss || '') + '</style></head><body>' +
    '<div class="brand noprint"><img src="' + LOGO_URL + '" alt="올케어에듀학원" onerror="this.style.display=\'none\'"><em>' + APP + '</em><span>' + kind + '</span></div><div class="wrap">' + body + '</div>' +
    '<div class="foot noprint">권일준 선생님 주간테스트 · 올케어에듀학원</div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('올케어에듀 · ' + APP + (kind ? ' (' + kind + ')' : ''))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

var CSS_ = 'body{margin:0;background:#F5F3F1;font:15px/1.55 -apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#1d2433}' +
  '.brand{background:#fff;color:' + BRAND + ';padding:9px 16px;border-bottom:3px solid ' + BRAND + ';display:flex;align-items:center;gap:10px;font-size:15px}.brand img{height:28px;width:auto;flex:0 0 auto;object-fit:contain;display:block}.brand em{font-style:normal;font-weight:700;border-left:1px solid #DDD5CF;padding-left:10px;white-space:nowrap}.brand span{margin-left:auto;color:#7a6f68;font-size:13px;white-space:nowrap}@media(max-width:380px){.brand{gap:8px;padding:8px 12px}.brand img{height:21px}.brand em{font-size:14px;padding-left:8px}}' +
  '.wrap{max-width:760px;margin:0 auto;padding:12px}.card{background:#fff;border-radius:12px;padding:14px 16px;margin:0 0 12px;box-shadow:0 1px 3px rgba(40,25,15,.08)}' +
  'h1{font-size:20px;margin:4px 0 2px}h2{font-size:16px;margin:0 0 10px;color:' + BRAND + '}h3{font-size:15px;margin:12px 0 6px}.sub{color:#7a6f68;font-size:13px}' +
  '.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.kpi{background:#F5F3F1;border-radius:10px;padding:10px 8px;text-align:center}.kpi b{display:block;font-size:20px;color:' + BRAND + '}.kpi small{color:#7a6f68;font-size:12px}' +
  '.bar{height:10px;background:#EDE7E2;border-radius:6px;overflow:hidden}.bar i{display:block;height:100%;background:' + BRAND + '}.bar i.hot{background:#B3261E}' +
  '.row{display:flex;align-items:center;gap:8px;margin:6px 0}.row .lab{width:150px;font-size:13px;flex:none}.row .bar{flex:1}.row .num{width:46px;text-align:right;font-size:13px;color:#7a6f68}' +
  'table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:6px 4px;border-bottom:1px solid #F0EBE7;text-align:left;vertical-align:top}th{color:#7a6f68;font-weight:600;white-space:nowrap}td.nw{white-space:nowrap}td.c,th.c{text-align:center}' +
  '.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;background:#F0EBE7;color:#5a4e46;margin:1px 2px 1px 0}.warn{background:#FDECEC;color:#B3261E}.ok{background:#E7F4EC;color:#1E7A57}.mid{background:#FFF4D6;color:#8A5A00}' +
  '.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}.tabs a{padding:7px 12px;border-radius:18px;background:#fff;color:' + BRAND + ';text-decoration:none;font-size:14px;box-shadow:0 1px 2px rgba(0,0,0,.06)}.tabs a.on{background:' + BRAND + ';color:#fff}' +
  'input,select{box-sizing:border-box;border:1px solid #DDD5CF;border-radius:8px;padding:7px;font:inherit}button,.btn{display:inline-block;background:' + BRAND + ';color:#fff;border:0;border-radius:8px;padding:9px 14px;font:inherit;cursor:pointer;text-decoration:none}button:disabled{opacity:.5}.btn.ghost{background:#fff;color:' + BRAND + ';border:1px solid ' + BRAND + '}' +
  '.alert{border-left:4px solid #B3261E;background:#FFF5F4;padding:10px 12px;border-radius:0 10px 10px 0;margin:8px 0}.alert b{color:#B3261E}' +
  '.tip{border-left:3px solid ' + BRAND + ';background:#FAF7F5;padding:8px 10px;border-radius:0 8px 8px 0;margin:6px 0;font-size:14px}.tip b{color:' + BRAND + '}' +
  '.rep{white-space:pre-wrap;font-size:14px;line-height:1.7}' +
  '.q{display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid #F3EEEA}.q .no{width:30px;font-weight:700;color:' + BRAND + ';text-align:right;flex:none}.q .opts{display:flex;gap:6px}' +
  '.o{width:40px;height:40px;border-radius:50%;border:1.5px solid #CFC5BD;background:#fff;color:#5a4e46;font-size:18px;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent}.o.on{background:' + BRAND + ';border-color:' + BRAND + ';color:#fff}' +
  '.sticky{position:sticky;bottom:0;background:#fff;border-top:1px solid #EDE7E2;padding:10px 0;display:flex;align-items:center;gap:10px;justify-content:space-between}' +
  '.res .x{color:#B3261E;font-weight:700}.note{font-size:12px;color:#7a6f68}.foot{text-align:center;color:#a39a93;font-size:12px;padding:16px}.muted{color:#a39a93}' +
  'svg{max-width:560px;display:block;margin:0 auto}details summary{cursor:pointer;color:' + BRAND + ';font-weight:600}' +
  '@media print{.noprint{display:none!important}body{background:#fff}.wrap{max-width:none;padding:0}.card{box-shadow:none;padding:0;margin:0 0 8px}}';

function kpis_(items) { return '<div class="kpis">' + items.map(function (k) { return '<div class="kpi"><b>' + k[1] + '</b><small>' + k[0] + '</small></div>'; }).join('') + '</div>'; }
function bars_(list, max, hot) {
  max = max || Math.max.apply(null, list.map(function (x) { return x[1]; }).concat([1]));
  return list.map(function (x) { return '<div class="row"><div class="lab">' + esc_(x[0]) + '</div><div class="bar"><i class="' + (hot && x[1] >= hot ? 'hot' : '') + '" style="width:' + Math.round(x[1] / max * 100) + '%"></i></div><div class="num">' + x[1] + (x[2] || '') + '</div></div>'; }).join('');
}
function trend_(pts) {
  if (!pts.length) return '<p class="muted">아직 채점된 테스트가 없습니다.</p>';
  var t = pts.slice(-12), W = 360, Hh = 200, L = 30, R = 12, T = 16, B = 28, n = t.length;
  var lo = Math.max(0, Math.min(60, Math.floor((Math.min.apply(null, t.map(function (e) { return e[1]; })) - 10) / 10) * 10));
  function x(i) { return L + (n === 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1)); }
  function y(v) { return T + (100 - v) / (100 - lo) * (Hh - T - B); }
  var grid = [lo, Math.round((lo + 100) / 20) * 10, 100].map(function (v) { return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#EDE7E2"/><text x="' + (L - 5) + '" y="' + (y(v) + 4) + '" font-size="11" text-anchor="end" fill="#a39a93">' + v + '</text>'; }).join('');
  var avg = t.filter(function (e) { return e[2] !== null && e[2] !== undefined; });
  var apl = avg.length > 1 ? '<polyline points="' + t.map(function (e, i) { return e[2] === null || e[2] === undefined ? '' : x(i) + ',' + y(e[2]); }).filter(String).join(' ') + '" fill="none" stroke="#CFC5BD" stroke-width="2" stroke-dasharray="4 4"/>' : '';
  var line = '<polyline points="' + t.map(function (e, i) { return x(i) + ',' + y(e[1]); }).join(' ') + '" fill="none" stroke="' + BRAND + '" stroke-width="2.5"/>';
  var dots = t.map(function (e, i) {
    return '<circle cx="' + x(i) + '" cy="' + y(e[1]) + '" r="4" fill="' + BRAND + '"></circle><text x="' + x(i) + '" y="' + (Hh - 9) + '" font-size="11" text-anchor="middle" fill="#7a6f68">' + esc_(e[0]) + '</text>' +
      '<text x="' + x(i) + '" y="' + (y(e[1]) - 8) + '" font-size="11" font-weight="700" text-anchor="middle" fill="' + BRAND + '">' + e[1] + '</text>';
  }).join('');
  return '<svg viewBox="0 0 ' + W + ' ' + Hh + '" width="100%" role="img" aria-label="점수 추이">' + grid + apl + line + dots + '</svg>' +
    (apl ? '<p class="note">실선: 내 점수 · 점선: 반 평균</p>' : '');
}
function nav_(items, on) {
  return '<div class="tabs noprint">' + items.map(function (x) { return '<a class="' + (x[0] === on ? 'on' : '') + '" href="' + x[1] + '" target="_top">' + esc_(x[2]) + '</a>'; }).join('') + '</div>';
}
function tipsHtml_(concepts, tips, label) {
  if (!concepts.length) return '';
  return concepts.map(function (c) {
    return '<div class="tip"><b>' + esc_(c.c) + '</b>' + (label ? ' <span class="note">' + esc_(label(c)) + '</span>' : '') + (tips[c.c] ? '<br>' + esc_(tips[c.c]) : '') + '</div>';
  }).join('');
}
function warnsHtml_(warns, who) {
  if (!warns.length) return '';
  return warns.map(function (w) {
    return '<div class="alert"><b>⚠ 같은 개념 반복 오답 · ' + esc_(w.c) + '</b><br>' +
      esc_(md_(w.prev.date)) + ' 테스트' + (who === '학부모' ? '' : '(' + w.prevNos.join('·') + '번)') + '에 이어 ' + esc_(md_(w.now.date)) + ' 테스트' +
      (who === '학부모' ? '' : '(' + w.nos.join('·') + '번)') + '에서도 틀렸습니다' + (w.streak > 2 ? ' · ' + w.streak + '회 연속' : '') + '.</div>';
  }).join('');
}

// ───────────────────────────── 학생 화면 ─────────────────────────────
function studentHtml_(w, p) {
  var A = studentAnalysis_(w.name, w.grade), tips = tipMap_(), view = p.v || '';
  var me = '?s=' + encodeURIComponent(w.code);
  var head = '<div class="card"><h1>' + esc_(w.name) + ' · 과학 주간테스트</h1><div class="sub">' + esc_(w.cls) + ' · 권일준 선생님 · ' + esc_(today_()) + '</div></div>';
  var open = A.res.filter(function (x) { return !closed_(x.t); }).reverse();
  var tabs = nav_([['', link_(me.slice(1)), '시험 입력'], ['r', link_(me.slice(1) + '&v=r'), '결과·리포트'], ['w', link_(me.slice(1) + '&v=w'), '오답 시험지']], view);
  var body = '';
  if (view === '') {
    var todo = open.filter(function (x) { return !x.s; });
    if (p.t) todo = A.res.filter(function (x) { return x.t.id === p.t && !x.s; });
    if (!todo.length) {
      body += '<div class="card"><h2>이번 주 시험</h2>' + (open.length ? open.map(function (x) { return resultLine_(x, me); }).join('') : '<p class="muted">지금 입력할 시험이 없습니다. 새 시험지가 올라오면 여기에 나옵니다.</p>') + '</div>';
    } else {
      var x = todo[0];
      body += answerForm_(w, x.t);
    }
    if (open.some(function (x) { return x.s; })) body += A.warns.length ? '<div class="card"><h2>반복 오답 경고</h2>' + warnsHtml_(A.warns.slice(-3), '학생') + '</div>' : '';
  } else if (view === 'r') {
    var pts = A.res.filter(function (x) { return x.s; }).map(function (x) { var cs = classStats_(x.t.id); return [md_(x.t.date), x.s.score, cs.avg]; });
    body += '<div class="card"><h2>점수 추이</h2>' + trend_(pts) + '</div>';
    if (A.warns.length) body += '<div class="card"><h2>⚠ 반복 오답 경고</h2>' + warnsHtml_(A.warns, '학생') + '</div>';
    A.res.slice().reverse().forEach(function (x) {
      if (!x.s) { body += '<div class="card"><h2>' + esc_(x.t.title) + '</h2><p class="muted">' + (closed_(x.t) ? '미응시' : '아직 입력하지 않았습니다 · ' + md_(x.t.deadline) + '(토) 자정까지') + '</p></div>'; return; }
      var miss = Object.keys(x.missC).map(function (c) { return { c: c, nos: x.missC[c], all: x.hasC[c] }; }).sort(function (a, b) { return b.nos.length - a.nos.length; });
      var rep = reports_(x.t.id, '학생', w.name);
      body += '<div class="card res"><h2>' + esc_(x.t.title) + ' · ' + x.s.score + '점</h2>' +
        '<div class="sub">' + esc_(x.t.unit) + ' · ' + x.s.right + '/' + x.s.n + '문항 · ' + esc_(x.s.src) + (x.s.late ? ' · <span class="pill mid">지각 제출</span>' : '') + '</div>' +
        (x.s.wrong.length ? '<p>틀린 문항: <span class="x">' + x.s.wrong.join(', ') + '</span></p>' : '<p>🎉 만점입니다!</p>') +
        (closed_(x.t) && x.s.wrong.length ? '<p class="noprint"><a class="btn" href="' + link_(me.slice(1) + '&w=' + encodeURIComponent(x.t.id)) + '" target="_top">📄 이 회차 오답 시험지</a></p>' : (x.s.wrong.length ? '<p class="note">정답·해설과 오답 시험지는 ' + md_(x.t.deadline) + '(토) 자정 마감 뒤에 열립니다.</p>' : '')) +
        (rep.length ? '<h3>선생님 리포트</h3><div class="rep">' + esc_(rep[0]) + '</div>' : '') +
        (miss.length ? '<h3>보완할 개념</h3>' + tipsHtml_(miss, tips, function (c) { return c.nos.length + '/' + c.all + '문항 틀림 · ' + c.nos.join('·') + '번'; }) : '') + '</div>';
    });
  } else if (view === 'w') {
    var done = A.res.filter(function (x) { return x.s && closed_(x.t) && x.s.wrong.length; }).reverse();
    body += '<div class="card"><h2>회차별 오답 시험지</h2>' + (done.length ? '<table>' + done.map(function (x) {
      return '<tr><td>' + esc_(x.t.title) + '</td><td class="c">' + x.s.wrong.length + '문항</td><td><a href="' + link_(me.slice(1) + '&w=' + encodeURIComponent(x.t.id)) + '" target="_top">열기</a></td></tr>';
    }).join('') + '</table>' : '<p class="muted">마감된 시험의 오답이 아직 없습니다.</p>') + '</div>';
    var first = done.length ? done[done.length - 1].t.date : addDays_(today_(), -28);
    body += '<div class="card"><h2>기간별 오답 모아 풀기</h2><p class="sub">기간 안에 마감된 시험의 틀린 문항을 한 번에 모읍니다(최대 ' + WRONG_SHEET_MAX + '문항).</p>' +
      '<form onsubmit="var f=this;top.location.href=\'' + link_(me.slice(1)) + '&from=\'+f.from.value+\'&to=\'+f.to.value;return false">' +
      '<input type="date" name="from" value="' + first + '"> ~ <input type="date" name="to" value="' + today_() + '"> <button>모아 보기</button></form></div>';
  }
  return head + tabs + body;
}
function resultLine_(x, me) {
  return '<p><b>' + esc_(x.t.title) + '</b> · ' + (x.s ? '제출 완료 <span class="pill ok">' + x.s.score + '점</span>' : '<span class="pill mid">미입력</span>') +
    ' <span class="note">마감 ' + md_(x.t.deadline) + '(토) 자정</span></p>';
}
function answerForm_(w, t) {
  var rows = '';
  for (var i = 1; i <= t.n; i++) {
    rows += '<div class="q"><div class="no">' + i + '</div><div class="opts">' + [1, 2, 3, 4, 5].map(function (d) { return '<div class="o" data-q="' + i + '" data-d="' + d + '">' + circ_(d) + '</div>'; }).join('') + '</div></div>';
  }
  var dl = md_(t.deadline);
  return '<div class="card"><h2>' + esc_(t.title) + ' · 답 입력</h2>' +
    '<div class="sub">' + esc_(t.unit) + ' · ' + t.n + '문항 · 마감 ' + dl + '(토) 자정</div>' +
    '<p class="note">시험지를 다 푼 뒤 고른 번호를 누르세요. 다시 누르면 지워집니다. 답이 두 개인 문항은 두 개 모두 누르세요.<br><b>한 번만 제출할 수 있습니다.</b> 입력 중인 답은 이 휴대폰에 자동 저장됩니다.</p>' +
    '<div id="qs">' + rows + '</div>' +
    '<div class="sticky noprint"><span id="cnt" class="sub">0 / ' + t.n + ' 입력</span><button id="go">제출하고 채점</button></div>' +
    '<div id="out"></div></div>' +
    '<script>(function(){var N=' + t.n + ',T=' + JSON.stringify(t.id) + ',C=' + JSON.stringify(w.code) + ',K="sci_"+C+"_"+T,A=[];' +
    'try{A=JSON.parse(localStorage.getItem(K)||"[]")}catch(e){}for(var i=0;i<N;i++)A[i]=A[i]||"";' +
    'function paint(){var c=0;document.querySelectorAll(".o").forEach(function(o){var q=+o.dataset.q-1;o.classList.toggle("on",A[q].indexOf(o.dataset.d)>=0)});A.forEach(function(a){if(a)c++});document.getElementById("cnt").textContent=c+" / "+N+" 입력";try{localStorage.setItem(K,JSON.stringify(A))}catch(e){}}' +
    'document.getElementById("qs").addEventListener("click",function(e){var o=e.target.closest(".o");if(!o)return;var q=+o.dataset.q-1,d=o.dataset.d;A[q]=A[q].indexOf(d)>=0?A[q].replace(d,""):(A[q]+d).split("").sort().join("");paint()});' +
    'document.getElementById("go").onclick=function(){var b=this,blank=[];A.forEach(function(a,i){if(!a)blank.push(i+1)});' +
    'if(blank.length&&!confirm(blank.length+"문항("+blank.slice(0,8).join(",")+(blank.length>8?"…":"")+")이 비어 있습니다. 이대로 제출할까요?"))return;' +
    'if(!blank.length&&!confirm("제출하면 고칠 수 없습니다. 제출할까요?"))return;b.disabled=true;b.textContent="채점 중…";' +
    'google.script.run.withSuccessHandler(function(r){try{localStorage.removeItem(K)}catch(e){}document.getElementById("qs").style.display="none";b.parentNode.style.display="none";' +
    'document.getElementById("out").innerHTML="<h2 style=\\"margin-top:12px\\">"+r.score+"점 · "+r.right+"/"+r.n+"문항</h2>"+(r.wrong.length?"<p>틀린 문항: <b style=\\"color:#B3261E\\">"+r.wrong.join(", ")+"</b></p><p class=\\"note\\">정답·해설과 오답 시험지는 토요일 자정 마감 뒤에 열립니다. [결과·리포트]에서 보완할 개념을 확인하세요.</p>":"<p>🎉 만점입니다!</p>")+(r.late?"<p class=\\"note\\">마감 뒤 제출이라 지각으로 기록됩니다.</p>":"")+"<p><a class=\\"btn\\" href=\\"' + link_('s=' + encodeURIComponent(w.code) + '&v=r') + '\\" target=\\"_top\\">결과·리포트 보기</a></p>";})' +
    '.withFailureHandler(function(e){b.disabled=false;b.textContent="제출하고 채점";alert(e.message||e)}).apiSubmit(C,T,A)};paint()})();</script>';
}

// ───────────────────────────── 학부모 화면 ─────────────────────────────
function parentHtml_(w, p) {
  var A = studentAnalysis_(w.name, w.grade), tips = tipMap_();
  var subs = A.res.filter(function (x) { return x.s; });
  var closed = A.res.filter(function (x) { return closed_(x.t); });
  var done = closed.filter(function (x) { return x.s; }).length;
  var last = subs.length ? subs[subs.length - 1] : null;
  var pts = subs.map(function (x) { var cs = classStats_(x.t.id); return [md_(x.t.date), x.s.score, cs.avg]; });
  var h = '<div class="card"><h1>' + esc_(w.name) + ' · 과학 학습 현황</h1><div class="sub">' + esc_(w.cls) + ' · 권일준 선생님 · ' + esc_(today_()) + ' 기준 · 학부모용</div></div>';
  h += '<div class="card">' + kpis_([['최근 점수', last ? last.s.score + '점' : '-'], ['응시', done + '/' + closed.length + '회'], ['반복 오답', A.warns.length ? A.warns.length + '건' : '없음']]) + '</div>';
  h += '<div class="card"><h2>점수 추이</h2>' + trend_(pts) + '</div>';
  if (A.warns.length) h += '<div class="card"><h2>⚠ 반복해서 틀리는 개념</h2>' + warnsHtml_(A.warns, '학부모') + '<p class="note">같은 개념을 연속으로 틀리면 표시됩니다. 수업에서 집중해서 다시 다룹니다.</p></div>';
  A.res.slice().reverse().slice(0, 6).forEach(function (x) {
    var st = x.s ? '<span class="pill ok">' + x.s.score + '점</span>' + (x.s.late ? '<span class="pill mid">지각</span>' : '') : (closed_(x.t) ? '<span class="pill warn">미응시</span>' : '<span class="pill">진행 중 · ' + md_(x.t.deadline) + '(토) 마감</span>');
    var rep = x.s ? reports_(x.t.id, '학부모', w.name) : [];
    var miss = Object.keys(x.missC).map(function (c) { return { c: c, nos: x.missC[c], all: x.hasC[c] }; }).sort(function (a, b) { return b.nos.length - a.nos.length; }).slice(0, 4);
    h += '<div class="card"><h2>' + esc_(x.t.title) + ' ' + st + '</h2><div class="sub">' + esc_(x.t.unit) + '</div>' +
      (rep.length ? '<div class="rep">' + esc_(rep[0]) + '</div>' : (miss.length ? '<h3>보완이 필요한 개념</h3>' + tipsHtml_(miss, tips, function (c) { return c.nos.length + '/' + c.all + '문항'; }) : (x.s ? '<p>틀린 개념 없이 잘 해냈습니다.</p>' : ''))) + '</div>';
  });
  h += '<p class="note" style="text-align:center">문의: 올케어에듀학원 010-4717-6373</p>';
  return h;
}

// ───────────────────────────── 강사 화면 ─────────────────────────────
function teacherHtml_(w, p) {
  var me = 'a=' + encodeURIComponent(p.a), tests = tests_(), tips = tipMap_();
  var grade = p.g || '고1';
  var gt = tests.filter(function (t) { return t.grade === grade; });
  var cur = p.t ? test_(p.t) : (gt.filter(function (t) { return closed_(t); }).slice(-1)[0] || gt.slice(-1)[0]);
  var h = '<div class="card"><h1>과학 주간테스트 · 강사 화면</h1><div class="sub">' + esc_(w.name) + ' · ' + esc_(now_()) + '</div></div>';
  h += nav_(['고1', '중3'].map(function (g) { return [g, link_(me + '&g=' + encodeURIComponent(g)), g]; }), grade);
  if (!cur) return h + '<div class="card"><p class="muted">등록된 시험이 없습니다.</p></div>';
  h += '<div class="card noprint"><form onsubmit="top.location.href=\'' + link_(me + '&g=' + encodeURIComponent(grade)) + '&t=\'+encodeURIComponent(this.t.value);return false">' +
    '<select name="t" onchange="this.form.onsubmit()">' + gt.slice().reverse().map(function (t) { return '<option value="' + esc_(t.id) + '"' + (t.id === cur.id ? ' selected' : '') + '>' + esc_(t.title) + ' (' + (closed_(t) ? '마감' : '진행 중') + ')</option>'; }).join('') + '</select></form></div>';
  var S = classStats_(cur.id);
  var subN = S.subs.length, all = S.roster.length;
  var missing = S.roster.filter(function (s) { return !S.subs.some(function (x) { return x.name === s.name; }); });
  h += '<div class="card"><h2>' + esc_(cur.title) + ' · ' + esc_(cur.unit) + '</h2><div class="sub">' + cur.n + '문항 · 마감 ' + md_(cur.deadline) + '(토) 자정 · ' + (closed_(cur) ? '마감됨' : '진행 중') + '</div>' +
    kpis_([['제출', subN + '/' + all + '명'], ['평균', S.avg === null ? '-' : S.avg + '점'], ['최고·최저', S.max === null ? '-' : S.max + ' · ' + S.min]]) +
    (missing.length ? '<p class="note">미제출: ' + missing.map(function (s) { return esc_(s.name) + '(' + esc_(s.cls) + ')'; }).join(', ') + '</p>' : '') + '</div>';
  var rep = reports_(cur.id, '반');
  if (rep.length) h += '<div class="card"><h2>수업 참고 리포트</h2><div class="rep">' + esc_(rep.join('\n\n')) + '</div></div>';
  // 반복 오답 경고(이 시험 기준)
  var warnRows = [];
  S.roster.forEach(function (s) { studentAnalysis_(s.name, s.grade).warns.filter(function (x) { return x.now.id === cur.id; }).forEach(function (x) { warnRows.push([s, x]); }); });
  if (warnRows.length) h += '<div class="card"><h2>⚠ 반복 오답 학생</h2><table><tr><th>학생</th><th>개념</th><th>이번</th><th>지난번</th></tr>' + warnRows.map(function (r) {
    return '<tr><td>' + esc_(r[0].name) + '</td><td>' + esc_(r[1].c) + (r[1].streak > 2 ? ' <span class="pill warn">' + r[1].streak + '연속</span>' : '') + '</td><td>' + r[1].nos.join('·') + '번</td><td>' + md_(r[1].prev.date) + ' ' + r[1].prevNos.join('·') + '번</td></tr>';
  }).join('') + '</table></div>';
  // 개념별
  if (subN) h += '<div class="card"><h2>개념별 오답률</h2>' + bars_(S.concepts.map(function (c) { return [c.c, c.rate, '%']; }), 100, 40) +
    '<details><summary>개념별 핵심 정리 · 틀린 학생</summary>' + S.concepts.filter(function (c) { return c.rate > 0; }).map(function (c) {
      return '<div class="tip"><b>' + esc_(c.c) + '</b> <span class="note">' + c.rate + '% · ' + esc_(c.who.join(', ')) + '</span>' + (tips[c.c] ? '<br>' + esc_(tips[c.c]) : '') + '</div>';
    }).join('') + '</details></div>';
  // 문항별
  if (subN) {
    var items = S.item.slice().sort(function (a, b) { return b.wrong.length - a.wrong.length || a.q.no - b.q.no; });
    h += '<div class="card"><h2>문항별 오답</h2><table><tr><th class="c">번호</th><th class="c">정답</th><th class="c">오답</th><th>개념</th><th>오답자(고른 답)</th></tr>' + items.map(function (it) {
      if (!it.wrong.length) return '';
      var picks = Object.keys(it.picks).map(function (k) { return (k === '무응답' ? '무응답' : ansTxt_(k)) + ' ' + it.picks[k]; }).join(' · ');
      return '<tr><td class="c"><b>' + it.q.no + '</b></td><td class="c">' + ansTxt_(it.q.ans) + '</td><td class="c">' + it.wrong.length + '/' + subN + '</td><td>' + esc_(it.q.c1) + '</td><td>' + esc_(it.wrong.join(', ')) + '<div class="note">' + esc_(picks) + '</div></td></tr>';
    }).join('') + '</table><p class="note">전원 정답 문항은 숨겼습니다.</p></div>';
  }
  // 학생별
  h += '<div class="card"><h2>학생별</h2><table><tr><th>반</th><th>이름</th><th class="c">점수</th><th>틀린 문항</th><th class="noprint"></th></tr>' + S.roster.map(function (s) {
    var x = S.subs.filter(function (y) { return y.name === s.name; })[0];
    return '<tr><td class="nw">' + esc_(s.cls) + '</td><td class="nw">' + esc_(s.name) + '</td><td class="c">' + (x ? x.score + (x.late ? '<br><span class="pill mid">지각</span>' : '') : '<span class="muted">-</span>') + '</td><td>' + (x ? (x.wrong.join(', ') || '없음') : '') + '</td><td class="noprint">' +
      (x && x.wrong.length ? '<a href="' + link_(me + '&u=' + encodeURIComponent(s.name) + '&w=' + encodeURIComponent(cur.id)) + '" target="_top">오답지</a> ' : '') +
      (x && x.src === '링크' ? '<a href="#" onclick="if(confirm(\'' + esc_(s.name) + ' 학생이 다시 제출할 수 있게 할까요?\'))google.script.run.withSuccessHandler(function(){top.location.reload()}).apiReset(' + esc_(JSON.stringify(p.a)) + ',' + esc_(JSON.stringify(s.name)) + ',' + esc_(JSON.stringify(cur.id)) + ');return false">재응시</a>' : '') + '</td></tr>';
  }).join('') + '</table></div>';
  // 기간별 오답지(학생 선택)
  h += '<div class="card noprint"><h2>학생 기간별 오답지</h2><form onsubmit="var f=this;top.location.href=\'' + link_(me) + '&u=\'+encodeURIComponent(f.u.value)+\'&from=\'+f.from.value+\'&to=\'+f.to.value;return false">' +
    '<select name="u">' + S.roster.map(function (s) { return '<option>' + esc_(s.name) + '</option>'; }).join('') + '</select> ' +
    '<input type="date" name="from" value="' + (gt[0] ? gt[0].date : today_()) + '"> ~ <input type="date" name="to" value="' + today_() + '"> <button>열기</button></form></div>';
  return h;
}

// ───────────────────────────── 오답 시험지 ─────────────────────────────
function wrongSheetPage_(w, p, isTeacher) {
  var tests = tests_().filter(function (t) { return t.grade === w.grade; }), sel;
  if (p.w) sel = tests.filter(function (t) { return t.id === p.w; });
  else sel = tests.filter(function (t) { return t.date >= String(p.from) && t.date <= String(p.to || '9999'); });
  if (!isTeacher) sel = sel.filter(closed_);
  var parts = [], total = 0, tips = tipMap_();
  sel.forEach(function (t) {
    var s = subOf_(w.name, t.id); if (!s || !s.wrong.length) return;
    var qs = questions_(t.id).filter(function (q) { return s.wrong.indexOf(q.no) >= 0; });
    qs.forEach(function (q) { q.mine = s.answers[q.no - 1]; });
    parts.push({ t: t, s: s, qs: qs }); total += qs.length;
  });
  var over = total > WRONG_SHEET_MAX, used = 0;
  var title = (p.w && parts[0]) ? parts[0].t.title + ' 오답 시험지' : '기간별 오답 시험지 (' + md_(p.from || '') + '~' + md_(p.to || today_()) + ')';
  var css = '.paper{background:#fff;padding:18px}.ph{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid ' + BRAND + ';padding-bottom:6px;margin-bottom:12px}.ph img{height:24px}' +
    '.qi{break-inside:avoid;page-break-inside:avoid;margin:0 0 14px}.qi .lab{font-size:13px;color:' + BRAND + ';font-weight:700;margin:0 0 4px}.qi img{max-width:100%;display:block}.qi .space{height:70px}' +
    '.ans{break-before:page;page-break-before:always}.ai{break-inside:avoid;page-break-inside:avoid;margin:0 0 12px;border-top:1px dashed #DDD5CF;padding-top:8px}.ai img{max-width:100%}' +
    '.key{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:4px;font-size:13px;margin:0 0 12px}' +
    '.qt{column-span:all;margin:6px 0}@page{size:A4;margin:11mm}@media print{.paper{padding:0}.qs,.es{column-count:2;column-gap:7mm;column-rule:1px solid #ddd}.qi .space{height:46px}.ph img{height:20px}}';
  var h = '<div class="noprint card"><b>' + esc_(w.name) + '</b> · ' + esc_(title) + ' · ' + Math.min(total, WRONG_SHEET_MAX) + '문항' +
    (over ? ' <span class="pill mid">' + WRONG_SHEET_MAX + '문항까지만 담았습니다</span>' : '') +
    '<br><button onclick="window.print()">🖨 PDF 저장 · 인쇄</button> <span class="note">인쇄 창에서 대상 → \'PDF로 저장\'</span></div>';
  if (!parts.length) return page_(isTeacher ? '강사' : '학생', h + '<div class="card"><p class="muted">' + (p.w && !isTeacher ? '이 회차는 마감(토 자정) 뒤에 열리거나, 틀린 문항이 없습니다.' : '해당 기간에 틀린 문항이 없습니다.') + '</p></div>', css);
  h += '<div class="paper"><div class="ph"><div><b style="font-size:18px">' + esc_(title) + '</b><div class="sub">' + esc_(w.cls) + ' ' + esc_(w.name) + ' · 권일준 선생님 과학</div></div><img src="' + LOGO_URL + '" alt=""></div><div class="qs">';
  var seenTip = {};
  var ansHtml = '<div class="ans"><div class="ph"><b style="font-size:16px">정답 · 해설</b><img src="' + LOGO_URL + '" alt=""></div><div class="key">';
  var expHtml = '';
  parts.forEach(function (pt) {
    if (used >= WRONG_SHEET_MAX) return;
    if (!p.w) h += '<h3 class="qt">' + esc_(pt.t.title) + ' · ' + esc_(pt.t.unit) + '</h3>';
    pt.qs.forEach(function (q) {
      if (used >= WRONG_SHEET_MAX) return; used++;
      var lab = (p.w ? '' : md_(pt.t.date) + ' ') + q.no + '번' + (q.c1 ? ' · ' + q.c1 : '');
      h += '<div class="qi"><div class="lab">' + esc_(lab) + '</div>' + (q.img ? '<img src="' + imgData_(q.img) + '">' : '<p class="muted">(그림 없음)</p>') + '<div class="space"></div></div>';
      ansHtml += '<div>' + esc_((p.w ? '' : md_(pt.t.date) + ' ') + q.no) + '번 <b>' + ansTxt_(q.ans) + '</b> <span class="note">(내 답 ' + ansTxt_(q.mine) + ')</span></div>';
      expHtml += '<div class="ai"><div class="lab"><b>' + esc_(lab) + '</b> 정답 ' + ansTxt_(q.ans) + '</div>' + (q.eimg ? '<img src="' + imgData_(q.eimg) + '">' : '<div style="white-space:pre-wrap;font-size:14px">' + esc_(q.exp) + '</div>') +
        (tips[q.c1] && !seenTip[q.c1] ? '<div class="tip"><b>' + esc_(q.c1) + '</b><br>' + esc_(tips[q.c1]) + '</div>' : '') + '</div>';
      seenTip[q.c1] = 1;
    });
  });
  h += '</div>' + ansHtml + '</div><div class="es">' + expHtml + '</div></div></div>';
  return page_(isTeacher ? '강사' : '학생', h, css);
}
function imgData_(id) {
  var c = CacheService.getScriptCache(), k = 'IMG_' + id, v = c.get(k);
  if (v) return v;
  try {
    var b = DriveApp.getFileById(id).getBlob();
    v = 'data:' + (b.getContentType() || 'image/png') + ';base64,' + Utilities.base64Encode(b.getBytes());
    if (v.length < 99000) c.put(k, v, 21600);
    return v;
  } catch (e) { return ''; }
}
