#!/usr/bin/env python3
"""R7-02: ES anchor extraction (generalization check). ES file has et_date+et_hhmm
precomputed (ET calendar). trade_date = et_date (+1 if et_hhmm>=1800). Output R7-es-anchors.csv"""
import pandas as pd, numpy as np

df = pd.read_csv("cache/ES_1m_primary.csv")
df = df.rename(columns={"c": "close"})
df["hhmm"] = df["et_hhmm"].astype(int)
ed = pd.to_datetime(df["et_date"])
df["trade_date"] = (ed + pd.to_timedelta(np.where(df["hhmm"] >= 1800, 1, 0), unit="D")).dt.strftime("%Y-%m-%d")

ANCHORS = [1800, 2000, 0, 400, 600, 830, 900, 915,
           930, 945, 1000, 1030, 1100, 1200, 1300, 1330,
           1400, 1430, 1500, 1515, 1530, 1545, 1600]

amask = df["hhmm"].isin(ANCHORS)
adf = df.loc[amask, ["trade_date", "hhmm", "close", "symbol"]].drop_duplicates(
    subset=["trade_date", "hhmm"], keep="last")
close_p = adf.pivot(index="trade_date", columns="hhmm", values="close").add_prefix("c_")
sym_p = adf.pivot(index="trade_date", columns="hhmm", values="symbol").add_prefix("s_")
out = close_p.join(sym_p)
out.index.name = "trade_date"
out.reset_index().to_csv("R7-es-anchors.csv", index=False)
print("wrote R7-es-anchors.csv rows:", len(out))
