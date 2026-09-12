/**
 * 경계 규칙 후보를 정답에 대고 채점한다.
 *
 * `measureObjectEdge` 가 태그별 확률을 줬는데 둘이 애매하게 남았다 — 주격 `이/가`
 * 38%, 부사격 `에/로` 37%. 애매한 이유는 짐작이 간다: 관형절 안에서는 주어도
 * 부사어도 목적어구의 일부다("개인정보**가** 포함된 필드"). 그 조건을 넣으면
 * 애매함이 사라지는지가 이 파일의 질문이고, 답이 그렇다면 규칙은 우리가 형태소
 * 분석기 없이도 쓸 수 있는 모양이 된다.
 *
 * 채점은 **정확 일치**로 한다. 목적어구는 사람이 표시한 경계가 있으므로 부분
 * 점수를 줄 이유가 없고, 잘린 대상과 넘친 대상은 둘 다 하네스를 틀린 것에
 * 맞춘다.
 *
 *   node scripts/measureEdgeRule.mjs
 */

import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync(".arena/klue-dp.json", "utf8"));

function subtree(head, at) {
  const kids = new Map();
  for (let i = 0; i < head.length; i += 1) {
    const h = head[i] - 1;
    if (h >= 0) kids.set(h, [...(kids.get(h) ?? []), i]);
  }
  const out = [];
  const stack = [at];
  while (stack.length > 0) {
    const n = stack.pop();
    out.push(n);
    for (const k of kids.get(n) ?? []) stack.push(k);
  }
  return out.sort((a, b) => a - b);
}

const lastTag = (p) => {
  const parts = p.split("+");
  return parts[parts.length - 1] ?? "?";
};
const hasTag = (p, t) => p.split("+").includes(t);

/** 언제나 안으로 잇는 태그. 확률 88% 이상인 것들. */
const JOIN = new Set(["NNG", "NNP", "NNB", "MMD", "MMN", "MM", "JKG", "ETM", "JC", "SS", "XSN", "SN", "SL"]);
/** 관형절 안에서만 안으로 잇는 태그. */
const JOIN_IN_CLAUSE = new Set(["JKS", "JKB", "MAG", "JKC", "JX"]);

/**
 * 후보 규칙들. 각각 목적어 어절에서 왼쪽으로 얼마나 갈지를 정한다.
 * 반환은 구의 시작 인덱스.
 */
const RULES = {
  "고정 1어절": (_pos, i) => i,
  "고정 2어절": (_pos, i) => Math.max(0, i - 1),
  "고정 3어절": (_pos, i) => Math.max(0, i - 2),
  "태그로 잇기": (pos, i) => {
    let s = i;
    while (s - 1 >= 0 && JOIN.has(lastTag(pos[s - 1]))) s -= 1;
    return s;
  },
  "태그로 잇기 + 관형절 안의 주어·부사어": (pos, i) => {
    let s = i;
    for (;;) {
      const prev = s - 1;
      if (prev < 0) break;
      const tag = lastTag(pos[prev]);
      if (JOIN.has(tag)) {
        s = prev;
        continue;
      }
      // 관형형 어미가 이 어절과 목적어 머리 사이에 있으면 관형절 안이다.
      const insideClause = pos.slice(prev + 1, i + 1).some((p) => hasTag(p, "ETM"));
      if (JOIN_IN_CLAUSE.has(tag) && insideClause) {
        s = prev;
        continue;
      }
      break;
    }
    return s;
  },
};

/**
 * 형태소 분석기 없이, 어절 문자열만 보고 같은 판단을 흉내 낸다.
 *
 * 위의 태그 규칙은 사람이 붙인 품사를 읽는다. 우리 추출기에는 그것이 없고 앞으로도
 * 없을 것이므로(설계 단계는 오프라인이고 의존성을 늘릴 자리가 아니다), 실제로 쓸 수
 * 있는 규칙은 표면형뿐이다. 태그 규칙의 점수는 상한이고, 이 점수가 우리가 가질 수
 * 있는 것이다.
 *
 * `는` 이 갈림길이다 — "탐지하**는**" 은 관형형 어미라 안이고 "필드**는**" 은
 * 보조사라 밖인데, 마지막 글자가 같다. 앞 음절이 용언 어간 꼴인지로 가른다.
 */
const STOP_PARTICLE = /(?:이|가|께서|은|는|도|만|밖에|조차|마저)$/;
const ADVERBIAL = /(?:에서|에게|에|으로|로|부터|까지|보다|처럼|만큼|대로|한테)$/;
const GENITIVE = /의$/;
const CONJUNCTION = /(?:와|과|랑|이랑|하고)$/;
/** 관형형 어미가 붙은 용언. `는` 앞이 용언 어간 꼴이거나, -ㄴ/-은/-ㄹ 활용형. */
const ADNOMINAL =
  /(?:하는|되는|있는|없는|보는|받는|주는|쓰는|나는|가는|오는|드는|무는|잡는|찾는|만드는|이루는|맞는|넘는)$|(?:된|한|인|같은|아닌|많은|적은|만든|남은|붙은|빠진|걸린|늘어난|줄어든|다른|새로운)$|(?:할|될|볼|줄|쓸)$/;

const surfaceStart = (words, i) => {
  let s = i;
  for (;;) {
    const prev = s - 1;
    if (prev < 0) break;
    const w = (words[prev] ?? "").replace(/[.,!?“”'’"()]/g, "");
    if (w.length === 0) break;
    // 관형형과 관형격, 접속은 안으로 잇는다. 순서가 중요하다 — `-는` 은 보조사
    // 검사보다 먼저 봐야 "탐지하는" 이 "필드는" 과 같은 취급을 받지 않는다.
    if (ADNOMINAL.test(w) || GENITIVE.test(w)) {
      s = prev;
      continue;
    }
    if (STOP_PARTICLE.test(w) || ADVERBIAL.test(w)) break;
    if (CONJUNCTION.test(w)) {
      s = prev;
      continue;
    }
    // 조사가 없는 맨 명사. 합성 명사구의 구성원이다.
    s = prev;
  }
  return s;
};

RULES["표면형만 보고 잇기 (분석기 없음)"] = (_pos, i, words) => surfaceStart(words, i);

const score = Object.fromEntries(Object.keys(RULES).map((k) => [k, { exact: 0, short: 0, long: 0 }]));
let n = 0;

for (const r of rows) {
  const { deprel, head, pos } = r;
  for (let i = 0; i < deprel.length; i += 1) {
    if (deprel[i] !== "NP_OBJ") continue;
    const span = subtree(head, i);
    if (span[span.length - 1] - span[0] + 1 !== span.length) continue;
    // 목적어 머리가 구의 오른쪽 끝인 경우만 본다. 우리 추출기는 동사 바로 앞에서
    // 왼쪽으로 읽으므로, 머리 뒤에 꼬리가 더 붙은 구는 애초에 다른 문제다.
    if (span[span.length - 1] !== i) continue;
    n += 1;
    for (const [name, rule] of Object.entries(RULES)) {
      const s = rule(pos, i, r.word_form);
      if (s === span[0]) score[name].exact += 1;
      else if (s > span[0]) score[name].short += 1;
      else score[name].long += 1;
    }
  }
}

console.log(`머리가 오른쪽 끝인 연속 목적어구 ${n}개\n`);
console.log("규칙                                    정확      잘림      과잉");
for (const [name, s] of Object.entries(score)) {
  const p = (x) => `${String(x).padStart(5)} ${((x / n) * 100).toFixed(1).padStart(5)}%`;
  console.log(`${name.padEnd(38)} ${p(s.exact)} ${p(s.short)} ${p(s.long)}`);
}
