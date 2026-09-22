#!/usr/bin/env python3
"""仿真对齐实测脚本:
1. 读取 /tmp/trace.json(由 gen_trace.js 从 index.html 提取生成的请求流:泊松到达+uniform长度+4组前缀)
2. 用 transformers tokenizer 精确构造每个请求的 prompt(token 数 == inputLen, 组内共享前缀)
3. 按 trace 的 arrive 时间并发发送 /v1/completions 流式请求(ignore_eos 强制输出 outputLen token)
4. 测量 TTFT(首token-arrive)/TPOT/完成时间, 输出与仿真 runSimulation 相同口径的指标

用法: MODEL=/data/models/DeepSeek-V3 python3 aligned_bench.py [founder_lead_s]
"""
import json, time, urllib.request, threading, statistics, sys, random, os

URL = os.environ.get("BENCH_URL", "http://127.0.0.1:8000/v1/completions")
MODEL = os.environ.get("BENCH_MODEL", "/models/Qwen3-32B")

# 可选: founder 提前量覆盖(实验: 验证前缀缓存的时间窗)
# 用法: python3 aligned_bench.py <founder_lead_s>
FOUNDER_LEAD = float(sys.argv[1]) if len(sys.argv) > 1 else None

# ---------- 1. trace ----------
trace = json.load(open("/tmp/trace.json"))
P = trace["p"]
REQS = trace["requests"]
N = len(REQS)

# ---------- 2. tokenizer 校准 ----------
from transformers import AutoTokenizer
TOK = AutoTokenizer.from_pretrained(MODEL)

def tlen(text):
    return len(TOK.tokenize(text))

# 动态筛选 1-token 词汇
CANDIDATE = ["the", "and", "of", "to", "in", "is", "that", "for", "with", "on", "at", "by",
             "KV", "cache", "model", "token", "layer", "key", "value", "attention", "memory",
             "speed", "fast", "data", "flow", "batch", "queue", "server", "GPU", "HBM", "DRAM",
             "SSD", "prefetch", "evict", "block", "tier", "latency", "throughput", "bandwidth",
             "compute", "decode", "prefill", "weight", "dense", "sparse", "router", "expert"]
VOCAB1 = [w for w in CANDIDATE if tlen(w) == 1 and tlen(" " + w) == 1]
print("VOCAB1 size:", len(VOCAB1), flush=True)

def exact_text(target, rseed=12345):
    """构造 token 数精确 == target 的文本(空格分隔英文词)。
    rseed 控制词序: 同 rseed → 相同文本(前缀组内共享); 不同 rseed → 不同文本(跨轮不污染缓存)"""
    if target <= 0:
        return ""
    rng = random.Random(rseed)
    def next_word():
        return VOCAB1[rng.randrange(len(VOCAB1))]
    acc = ""
    i = 0
    while True:
        word = next_word()
        nxt = acc + word + " "
        tn = tlen(nxt)
        if tn == target:
            return nxt
        if tn > target:
            # 二分: 在 acc 基础上取 word 的字符前缀, 找 token<=target 的最大前缀
            lo, hi = 0, len(word)
            best = acc
            while lo <= hi:
                mid = (lo + hi) // 2
                cand = acc + word[:mid]
                tm = tlen(cand)
                if tm <= target:
                    best = cand
                    lo = mid + 1
                else:
                    hi = mid - 1
            # 若仍差 1-2, 追加单 token 词/符号
            deficit = target - tlen(best)
            if deficit > 0:
                for extra in VOCAB1 + ["!", "?", ".", ",", ":", ";"]:
                    for sep in [" ", ""]:
                        if tlen(best + sep + extra) == target:
                            best = best + sep + extra
                            deficit = 0
                            break
                    if deficit == 0:
                        break
            return best
        acc = nxt
        i += 1


def exact_text_fast(target, rseed=12345):
    """exact_text 加速版: 50-token 单位块重复 + 尾部精调。
    长 prompt(如 8192)下从 O(n²) 降到 O(n) 次 tokenize(单位构造一次 + 验证 + 尾部)。"""
    if target <= 0:
        return ""
    UNIT_N = 50
    if target <= UNIT_N:
        return exact_text(target, rseed)
    unit = exact_text(UNIT_N, rseed)          # 一次慢构造
    units = target // UNIT_N
    base = unit * units
    tb = tlen(base)
    if tb > target:                            # 块边界融合, 退一块
        units -= 1
        base = unit * max(1, units)
        tb = tlen(base)
    if tb < target:
        tail = exact_text(target - tb, rseed + 1)
        cand = base + " " + tail
        tc = tlen(cand)
        if tc == target:
            return cand
        if tc < target:
            for extra in VOCAB1 + ["!", "?", ".", ",", ":", ";"]:
                for sep in [" ", ""]:
                    if tlen(cand + sep + extra) == target:
                        return cand + sep + extra
    return base  # 兜底: 略短(≤50 token 内), 影响可忽略

# 构造前缀文本(按组缓存; rseed 由组 id 派生 → 组内一致、跨轮不同)
group_prefix_cache = {}
def get_group_prefix(gid, prefixTokLen):
    key = (gid, prefixTokLen)
    if key not in group_prefix_cache:
        gseed = 9000 + abs(hash(gid)) % 1000
        group_prefix_cache[key] = exact_text_fast(prefixTokLen, gseed)
    return group_prefix_cache[key]

# 预构造所有请求的 prompt
t0_prep = time.time()
for r in REQS:
    if r["groupId"] and r["prefixTokLen"] > 0:
        pfx = get_group_prefix(r["groupId"], r["prefixTokLen"])
        rest = exact_text_fast(r["inputLen"] - r["prefixTokLen"], 5000 + r["id"] * 7)
        r["prompt"] = pfx + rest
    else:
        r["prompt"] = exact_text_fast(r["inputLen"], 5000 + r["id"] * 7)
    # 校验
    got = tlen(r["prompt"])
    r["actualLen"] = got
    if got != r["inputLen"]:
        print("WARN req", r["id"], "target", r["inputLen"], "got", got, flush=True)
print("prompt 构造完成, 耗时 %.1fs" % (time.time() - t0_prep), flush=True)

# ---------- 3. 并发发送 ----------
def stream_completion(prompt, max_tokens, req):
    body = json.dumps({
        "model": MODEL, "prompt": prompt, "max_tokens": max_tokens,
        "temperature": 0.0, "ignore_eos": True, "stream": True,
    }).encode()
    reqq = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    t_arr = req["_wall_arrive"]
    first_ts = None
    ts_list = []
    err = None
    try:
        with urllib.request.urlopen(reqq, timeout=600) as resp:
            for line in resp:
                line = line.decode("utf-8", "ignore").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                ch = obj.get("choices") or []
                if not ch:
                    continue
                txt = ch[0].get("text") or ""
                if txt:
                    now = time.time()
                    if first_ts is None:
                        first_ts = now
                    ts_list.append(now)
    except Exception as e:
        err = str(e)
    n = len(ts_list)
    now = time.time()
    res = {
        "id": req["id"], "groupId": req["groupId"], "isFounder": req["isFounder"],
        "arrive": round(req["arrive"], 3), "inputLen": req["inputLen"], "outputLen": req["outputLen"],
        "prefixTokLen": req.get("prefixTokLen", 0),
        "ttft_ms": round((first_ts - t_arr) * 1000, 1) if first_ts else None,
        "tpot_ms": round((ts_list[-1] - ts_list[0]) / (n - 1) * 1000, 2) if n > 1 else None,
        "tokens": n, "lat_ms": round((now - t_arr) * 1000, 1),
        "err": err,
    }
    return res

# 基准时刻: 让 arrive=0 的请求尽快发出
wall_t0 = time.time() + 1.0  # 1s 准备余量
for r in REQS:
    r["_wall_arrive"] = wall_t0 + r["arrive"]
if FOUNDER_LEAD is not None:
    for r in REQS:
        if r["isFounder"]:
            r["_wall_arrive"] = wall_t0 + r["arrive"] - FOUNDER_LEAD
    print("FOUNDER_LEAD =", FOUNDER_LEAD, "s (实验模式)", flush=True)

results = []
lock = threading.Lock()
def worker(r):
    sleep_t = r["_wall_arrive"] - time.time()
    if sleep_t > 0:
        time.sleep(sleep_t)
    r["_wall_sent"] = time.time()
    res = stream_completion(r["prompt"], r["outputLen"], r)
    with lock:
        results.append(res)
        # 实时打印
        print(json.dumps(res, ensure_ascii=False), flush=True)

threads = [threading.Thread(target=worker, args=(r,)) for r in REQS]
for t in threads:
    t.start()
for t in threads:
    t.join()

# ---------- 4. 汇总(与仿真口径一致) ----------
ok = [r for r in results if r["ttft_ms"] is not None]
ttfts = [r["ttft_ms"] for r in ok]
tpots = [r["tpot_ms"] for r in ok if r["tpot_ms"] is not None]
lats = [r["lat_ms"] for r in ok]

def pct(a, q):
    s = sorted(a)
    return s[min(len(s) - 1, int(round(q * (len(s) - 1))))]

print("### SUMMARY", flush=True)
if ttfts:
    print(json.dumps({
        "n_completed": len(ok), "n_total": N,
        "ttft_avg_ms": round(statistics.mean(ttfts), 1),
        "ttft_p50_ms": round(pct(ttfts, 0.5), 1),
        "ttft_p99_ms": round(pct(ttfts, 0.99), 1),
        "tpot_avg_ms": round(statistics.mean(tpots), 2) if tpots else None,
        "lat_avg_ms": round(statistics.mean(lats), 1),
        "total_input_tok": sum(r["inputLen"] for r in ok),
        "total_output_tok": sum(r["tokens"] for r in ok),
        "sim_end_s": round(max(r["arrive"] for r in REQS) + max((r["lat_ms"] / 1000) for r in ok), 2),
    }, ensure_ascii=False), flush=True)
# 分前缀组统计(验证前缀缓存收益)
print("### BY_GROUP", flush=True)
gmap = {}
for r in results:
    g = r["groupId"] or "no-prefix"
    gmap.setdefault(g, []).append(r)
for g, rs in gmap.items():
    f = [r for r in rs if r["isFounder"]]
    oth = [r for r in rs if not r["isFounder"]]
    def tavg(arr):
        v = [r["ttft_ms"] for r in arr if r["ttft_ms"] is not None]
        return round(statistics.mean(v), 1) if v else None
    print(json.dumps({"group": g, "n": len(rs), "founder_ttft": tavg(f), "others_ttft": tavg(oth)}, ensure_ascii=False), flush=True)
