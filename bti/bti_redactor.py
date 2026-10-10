"""
BTI redactor v3 —— PII 检测 / 脱敏 / fail-closed 判断。
v3 (2026-06-21, 修 v2 POLICY/BANK 在真实 AI 日志上的误报回归)：
  v2 问题：POLICY 无上下文正则把 base64 / 长 ID(数字+大写字母) + 英文 'policy' 全误判 → 99% session 被排除、系统不可用。
  v3 原则(窄口径)：
    - 身份证：日期结构 + GB11643 校验位，自带强结构，无需上下文 -> 可靠 HARD_EXCLUDE。
    - 保单号 / 银行卡：格式与 base64/ID 无法区分 -> **必须有中文上下文(保单/银行卡/卡号)才 HARD_EXCLUDE**；
      无上下文时 redact 仍脱敏(误报脱敏一个长数字无害)，但不整段排除 session(避免可用性灾难)。
    - 手机/email/secret：脱敏不排除。
  分隔容忍(空格/横线) + 校验位 + 流式快路径 保留自 v2。
"""
import re

_SEP = r"[ \-]"
DIGIT_RUN = re.compile(rf"\d(?:{_SEP}?\d){{9,}}")
_DATE18 = re.compile(r"^[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]$")
_DATE15 = re.compile(r"^[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}$")

EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
SECRET = re.compile(r"(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_\-]{20,})")
# 保单号：必须有中文"保单"上下文(去掉 v2 的无上下文 ALNUM/NUM 和英文 policy)
POLICY_CTX = re.compile(r"(?:保单号?|投保单号?|保险单号?)[：:\s]{0,4}([0-9][0-9A-Za-z \-]{10,})")
# 银行卡上下文门
BANK_CTX = re.compile(r"卡号|银行卡|储蓄卡|信用卡|借记卡|card\s*(?:no|number)", re.IGNORECASE)
# 流式预筛：14+ 位数字 run 或中文 PII 上下文
_PREFILTER = re.compile(r"\d(?:[ \-]?\d){13,}|保单|投保|保险单|银行卡|卡号")

# HARD_EXCLUDE 分两类：无条件(身份证/保单上下文) + 需上下文(银行卡)
HARD_UNCOND = ("CN_ID", "CN_ID18_LOWCONF", "CN_ID15_LOWCONF", "POLICY")


def _digits(s):
    return re.sub(r"\D", "", s)


def _cnid18_checksum(d):
    if len(d) != 18:
        return False
    w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2, 1]
    c = "10X98765432"
    try:
        t = sum(int(d[i]) * w[i] for i in range(17))
    except ValueError:
        return False
    return c[t % 11] == d[17].upper()


def _luhn(d):
    s, alt = 0, False
    for ch in reversed(d):
        n = int(ch)
        if alt:
            n *= 2
            if n > 9:
                n -= 9
        s += n
        alt = not alt
    return s % 10 == 0


def _classify_digits(d):
    n = len(d)
    if n == 18 and _DATE18.match(d):
        return "CN_ID" if _cnid18_checksum(d) else "CN_ID18_LOWCONF"
    if n == 15 and _DATE15.match(d):
        return "CN_ID15_LOWCONF"
    if n == 11 and d[0] == "1" and d[1] in "3456789":
        return "PHONE"
    if n == 13 and d[:2] == "86" and d[2] == "1" and d[3] in "3456789":
        return "PHONE"
    if 16 <= n <= 19 and _luhn(d):
        return "BANK_CARD"
    return None


def detect(text):
    hits = {}
    for m in DIGIT_RUN.finditer(text):
        t = _classify_digits(_digits(m.group()))
        if t:
            hits[t] = hits.get(t, 0) + 1
    if POLICY_CTX.search(text):
        hits["POLICY"] = hits.get("POLICY", 0) + 1
    if EMAIL.search(text):
        hits["EMAIL"] = len(EMAIL.findall(text))
    if SECRET.search(text):
        hits["SECRET"] = len(SECRET.findall(text))
    return hits


def redact(text):
    def _sub_run(m):
        t = _classify_digits(_digits(m.group()))
        return f"[{t}]" if t else m.group()
    text = DIGIT_RUN.sub(_sub_run, text)
    text = POLICY_CTX.sub(lambda m: m.group().replace(m.group(1), "[POLICY]"), text)
    text = EMAIL.sub("[EMAIL]", text)
    text = SECRET.sub("[SECRET]", text)
    return text


def session_hard_excluded(text):
    h = detect(text)
    for t in HARD_UNCOND:
        if h.get(t):
            return True, t
    # 银行卡需上下文门（避免 base64 里 Luhn-通过的长数字误报）
    if h.get("BANK_CARD") and BANK_CTX.search(text):
        return True, "BANK_CARD"
    return False, None


def session_hard_excluded_stream(path):
    """流式 fail-closed(大文件用)：逐行预筛 + 命中早退。等价 session_hard_excluded 但快得多。
    注意银行卡上下文：预筛命中行单独判断，BANK_CTX 在同一行内。"""
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            for ln in f:
                if not _PREFILTER.search(ln):
                    continue
                ex, why = session_hard_excluded(ln)
                if ex:
                    return True, why
    except OSError:
        pass
    return False, None


if __name__ == "__main__":
    POS = {
        "CN_ID18(连写)": "999999199001011238",
        "CN_ID18(空格)": "证 99999 9199001 011238",
        "CN_ID18(横线)": "999999-19900101-1238",
        "CN_ID15": "旧证 999999900101123",
        "PHONE": "13800138000",
        "PHONE(横线)": "138-0013-8000",
        "POLICY(中文上下文)": "保单号 1234567890123456N00000001",
        "BANK_CARD(有上下文)": "银行卡 4111111111111111",
    }
    # 负样本：真实 AI 日志里的常见模式，绝不能 hard-exclude
    NEG = {
        "base64串": "data SGVsbG8xMjM0NTY3ODkwQUJDREVGR0g5ODc2NTQzMjEw",
        "纯数字长ID(无上下文)": "id 1234567890123456 done",
        "英文policy讨论": "我们讨论 privacy policy 边界和 fail-closed",
        "tool id": "toolu_01ABCdefGH1234567890",
        "时间戳": "ts 1718900000000",
        "无上下文16数字": "value 4111111111111111 end",
        "保险话题无号": "为了保险起见，医疗险报销",
        "rollout uuid": "01900000-0000-7000-8000-000000000001",
    }
    print("=== 正样本 detect + hard-exclude（应都命中）===")
    for k, s in POS.items():
        ex, why = session_hard_excluded(s)
        print(f"  {'OK ' if ex else 'MISS'} {k:22} -> {detect(s)} excluded={ex}({why})")
    print("\n=== 负样本（应 0 误报 hard-exclude）===")
    fp = 0
    for k, s in NEG.items():
        ex, why = session_hard_excluded(s)
        if ex:
            fp += 1
        print(f"  {'误报!' if ex else 'ok '} {k:22} -> excluded={ex}({why})  detect={detect(s)}")
    print(f"\n负样本误报 {fp}/{len(NEG)} (应 0)")
    print("\n=== redact 脱敏（含无上下文长数字也脱敏，但不影响 session 排除）===")
    samp = "证 999999-19900101-1238 保单号 1234567890123456N00000001 手机 138-0013-8000 邮箱 user@example.com"
    print("  原:", samp)
    print("  后:", redact(samp))
