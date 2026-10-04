/* Ядро калькуляторов юридического сайта (без DOM, чтобы тестировать в node).
   1) компенсация за задержку выплат, ст. 236 ТК РФ: 1/150 ключевой ставки за каждый день;
   2) срок обращения: ст. 392 ТК, ст. 196 ГК, ст. 219 КАС, ст. 30.3 КоАП, ст. 12 59-ФЗ. */
(function (root) {
  'use strict';
  var DAY = 86400000;

  function parse(s) { // 'ГГГГ-ММ-ДД' -> UTC-день
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    if (+m[1] < 2000 || +m[1] > 2100) return null;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    var d = new Date(t);
    if (d.getUTCMonth() !== +m[2] - 1) return null;
    return t;
  }
  function fmt(t) {
    var d = new Date(t);
    return ('0' + d.getUTCDate()).slice(-2) + '.' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '.' + d.getUTCFullYear();
  }
  function rub(x) { return Math.round(x * 100) / 100; }

  /* rows: [{amount, due, paid}] ; rates: [{from, rate}] (ставка в % годовых, действует с даты from).
     Дни считаются со следующего дня после срока выплаты по день выплаты включительно. */
  function compensation(rows, rates) {
    var rs = (rates || []).map(function (r) { return { t: parse(r.from), rate: +r.rate }; })
      .filter(function (r) { return r.t !== null && isFinite(r.rate) && r.rate >= 0; })
      .sort(function (a, b) { return a.t - b.t; });
    if (!rs.length) return { error: 'Укажите ключевую ставку и дату, с которой она действует' };
    var total = 0, days = 0, out = [];
    for (var i = 0; i < rows.length; i++) {
      var a = +rows[i].amount, due = parse(rows[i].due), paid = parse(rows[i].paid);
      if (!(a > 0) || due === null || paid === null) return { error: 'Строка ' + (i + 1) + ': проверьте сумму и даты' };
      if (paid <= due) { out.push({ days: 0, sum: 0 }); continue; }
      if (rs[0].t > due + DAY) return { error: 'Ставка должна действовать с даты не позже первого дня просрочки (' + fmt(due + DAY) + ')' };
      var sum = 0, n = 0, k = 0;
      for (var d = due + DAY; d <= paid; d += DAY) {
        while (k + 1 < rs.length && rs[k + 1].t <= d) k++;
        sum += a * rs[k].rate / 100 / 150;
        n++;
      }
      out.push({ days: n, sum: rub(sum) });
      total += sum; days += n;
    }
    return { rows: out, total: rub(total), days: days };
  }

  function addMonths(t, n) { // ст. 192 ГК: соответствующее число, иначе последний день месяца
    var d = new Date(t), y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(day, last));
  }
  function shiftWeekend(t) { // ст. 193 ГК: выходной -> ближайший рабочий (праздники не учитываются)
    var wd = new Date(t).getUTCDay();
    if (wd === 6) return { t: t + 2 * DAY, moved: true };
    if (wd === 0) return { t: t + DAY, moved: true };
    return { t: t, moved: false };
  }

  var TYPES = {
    tk392_3m:   { name: 'Трудовой спор (общий срок)', norm: 'ст. 392 ч. 1 ТК РФ', rule: '3 месяца со дня, когда узнали или должны были узнать о нарушении', add: { m: 3 }, from: 'День, когда вы узнали или должны были узнать о нарушении', recover: 'Пропущенный срок суд может восстановить, если причины уважительные (ст. 392 ч. 4 ТК РФ).' },
    tk392_wage: { name: 'Невыплаченная зарплата и выплаты', norm: 'ст. 392 ч. 2 ТК РФ', rule: '1 год со дня, когда выплата должна была быть произведена (при увольнении - со дня расчёта по ст. 140 ТК)', add: { m: 12 }, from: 'Дата, когда деньги должны были прийти', recover: 'Пропущенный срок суд может восстановить, если причины уважительные (ст. 392 ч. 4 ТК РФ).' },
    tk392_fire: { name: 'Спор об увольнении', norm: 'ст. 392 ч. 1 ТК РФ', rule: '1 месяц со дня вручения приказа или выдачи трудовой книжки (сведений о трудовой деятельности)', add: { m: 1 }, from: 'День вручения приказа или выдачи трудовой книжки', recover: 'Пропущенный срок суд может восстановить, если причины уважительные (ст. 392 ч. 4 ТК РФ).' },
    gk196:      { name: 'Гражданский иск (общий срок давности)', norm: 'ст. 196 ГК РФ', rule: '3 года, но не более 10 лет со дня нарушения. Для долгов с датой оплаты срок идёт со дня, когда платёж должен был быть сделан (ст. 200 ГК)', add: { m: 36 }, from: 'День, когда вы узнали о нарушении права (для долга с датой оплаты - эта дата)', recover: 'Суд применяет давность только по заявлению ответчика. Восстановить срок гражданину можно лишь в исключительных случаях и только в последние 6 месяцев срока (ст. 205 ГК).' },
    kas219:     { name: 'Оспорить решение или бездействие органа власти', norm: 'ст. 219 КАС РФ', rule: '3 месяца со дня, когда стало известно о нарушении', add: { m: 3 }, from: 'День, когда вам стало известно о нарушении', recover: 'Срок можно восстановить, если причины уважительные (ст. 219 КАС РФ).' },
    koap303:    { name: 'Жалоба на постановление по делу об административном правонарушении', norm: 'ст. 30.3 КоАП РФ', rule: '10 суток со дня вручения или получения копии', add: { d: 10 }, from: 'День вручения или получения копии постановления', recover: 'Срок можно восстановить по ходатайству, если причины уважительные (ст. 30.3 КоАП РФ).' },
    ob59:       { name: 'Когда ждать ответ на обращение в орган или организацию', norm: 'ст. 12 ФЗ-59', rule: '30 дней со дня регистрации обращения; в исключительных случаях орган может продлить ещё на 30 дней', add: { d: 30 }, from: 'День регистрации обращения', info: true, recover: '' }
  };

  function deadline(type, start) {
    var ty = TYPES[type], s = parse(start);
    if (!ty) return { error: 'Выберите вид срока' };
    if (s === null) return { error: 'Укажите дату' };
    var end = ty.add.m ? addMonths(s, ty.add.m) : s + ty.add.d * DAY;
    var sh = shiftWeekend(end);
    return { end: sh.t, endText: fmt(sh.t), nominal: fmt(end), moved: sh.moved, type: ty };
  }

  var api = { parse: parse, fmt: fmt, compensation: compensation, deadline: deadline, TYPES: TYPES, DAY: DAY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LegalCalc = api;
})(typeof window !== 'undefined' ? window : this);
