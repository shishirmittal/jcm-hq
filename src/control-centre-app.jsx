import { useState, useEffect, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area, Legend
} from "recharts";
import { busyFetch } from "./busy-config.js";
import { openSidebar } from "./sidebar.js";

const q = (v, p = "") => busyFetch(`${v}?${p}`);

const N = (x) => Number(x) || 0;
const rs = (n) => {
  n = N(n);
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${s}₹${(a / 1e3).toFixed(1)}K`;
  return `${s}₹${a.toFixed(0)}`;
};
const ax = (n) => {
  const a = Math.abs(N(n));
  if (a >= 1e7) return (a / 1e7).toFixed(1) + "Cr";
  if (a >= 1e5) return (a / 1e5).toFixed(0) + "L";
  if (a >= 1e3) return (a / 1e3).toFixed(0) + "K";
  return a.toFixed(0);
};
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const mlabel = (d) => { const x = new Date(d); return MON[x.getMonth()] + " " + String(x.getFullYear()).slice(2); };

const C = {
  bg: "#0f1117", card: "#171a23", line: "#242835",
  text: "#e6e8ef", dim: "#8b90a3", faint: "#5a5f73",
  ind: "#6366f1", amb: "#f59e0b", grn: "#10b981", red: "#ef4444", cyn: "#06b6d4", vio: "#a855f7",
};
const PAL = ["#6366f1","#f59e0b","#10b981","#06b6d4","#a855f7","#ef4444","#ec4899","#84cc16","#f97316","#14b8a6"];

export default function ControlCentreApp({ isAdmin }) {
  const [tab, setTab] = useState("Overview");
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [months, setMonths] = useState(12);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [mrev, drev, cust, sgrp, items, dsum, droute, stock] = await Promise.all([
        q("v_monthly_revenue", "order=month.asc"),
        q("v_daily_revenue", "order=day.asc"),
        q("v_top_customers", "order=revenue.desc&limit=25"),
        q("v_sales_by_group", "order=revenue.desc"),
        q("v_top_items", "order=revenue.desc&limit=25"),
        q("v_dues_summary", ""),
        q("v_dues_by_route", "order=total.desc"),
        q("v_stock_by_group", "order=stock_value.desc"),
      ]);
      setD({ mrev, drev, cust, sgrp, items, dsum, droute, stock });
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (err) return <Shell><Msg t="Could not load" s={err} /></Shell>;
  if (!d) return <Shell><Msg t="Loading" s="Fetching from Busy ERP…" /></Shell>;

  const mrev = d.mrev.map(r => ({ ...r, label: mlabel(r.month), revenue: N(r.revenue), invoices: N(r.invoices) }));
  const shown = mrev.slice(-months);
  const totalRev = mrev.reduce((s, r) => s + r.revenue, 0);
  const totalInv = mrev.reduce((s, r) => s + r.invoices, 0);
  const cur = mrev[mrev.length - 1] || {};
  const prev = mrev[mrev.length - 2] || {};
  const mom = prev.revenue ? ((cur.revenue - prev.revenue) / prev.revenue) * 100 : 0;

  const now = new Date();
  const fyStart = new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 3, 1);
  const fy = mrev.filter(r => new Date(r.month) >= fyStart);
  const fyRev = fy.reduce((s, r) => s + r.revenue, 0);

  const recv = d.dsum.filter(r => r.due_type === "Receivable");
  const totalRecv = recv.reduce((s, r) => s + N(r.total), 0);
  const recvParties = recv.reduce((s, r) => s + N(r.parties), 0);
  const retail = recv.find(r => r.segment === "Retail") || {};
  const dist = recv.find(r => r.segment === "Distribution") || {};
  const payable = d.dsum.filter(r => r.due_type === "Payable").reduce((s, r) => s + N(r.total), 0);

  const stockVal = d.stock.reduce((s, r) => s + N(r.stock_value), 0);
  const skus = d.stock.reduce((s, r) => s + N(r.skus), 0);
  const daily = d.drev.map(r => ({ ...r, label: r.day.slice(8) + "/" + r.day.slice(5,7), revenue: N(r.revenue) }));
  const segPie = [
    { name: "Retail", value: N(retail.total) },
    { name: "Distribution", value: N(dist.total) },
  ].filter(x => x.value > 0);

  const TABS = ["Overview","Revenue","Receivables","Customers","Products","Inventory"];

  return (
    <Shell>
      <div style={{ background: C.card, borderBottom: `1px solid ${C.line}`, padding: "0 20px", height: 52,
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    position: "sticky", top: 0, zIndex: 30 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => openSidebar({ isAdmin })} style={hamburgerStyle} aria-label="Menu">☰</button>
          <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>JCM Retails</span>
          <span style={{ fontSize: 11, color: C.faint, letterSpacing: ".08em", textTransform: "uppercase" }}>Control Centre</span>
        </div>
        <button onClick={load} style={btn(false)}>Refresh</button>
      </div>

      <div style={{ background: C.card, borderBottom: `1px solid ${C.line}`, padding: "0 20px",
                    display: "flex", gap: 2, overflowX: "auto" }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "11px 16px", fontSize: 13, fontWeight: 500, border: "none", background: "none",
            cursor: "pointer", whiteSpace: "nowrap",
            color: tab === t ? C.ind : C.dim,
            borderBottom: `2px solid ${tab === t ? C.ind : "transparent"}`,
          }}>{t}</button>
        ))}
      </div>

      <div style={{ padding: 20, maxWidth: 1280, margin: "0 auto" }}>

        {tab === "Overview" && (
          <Col>
            <Grid min={190}>
              <Stat label="Revenue this FY" value={rs(fyRev)} sub={`${fy.length} months`} accent={C.ind} />
              <Stat label={cur.label || "Latest month"} value={rs(cur.revenue)}
                    sub={`${mom >= 0 ? "▲" : "▼"} ${Math.abs(mom).toFixed(1)}% vs ${prev.label || "prev"}`}
                    accent={mom >= 0 ? C.grn : C.red} />
              <Stat label="Receivables" value={rs(totalRecv)} sub={`${recvParties} parties`} accent={C.amb} />
              <Stat label="Payables" value={rs(Math.abs(payable))} accent={C.vio} />
              <Stat label="Stock value" value={rs(stockVal)} sub={`${skus.toLocaleString("en-IN")} SKUs`} accent={C.cyn} />
              <Stat label="Avg invoice" value={rs(totalInv ? totalRev / totalInv : 0)}
                    sub={`${totalInv.toLocaleString("en-IN")} invoices`} accent={C.dim} />
            </Grid>

            <Two>
              <Card title="Revenue trend" right={
                <div style={{ display: "flex", gap: 4 }}>
                  {[6, 12, 24, 99].map(m => (
                    <button key={m} onClick={() => setMonths(m)} style={btn(months === m)}>
                      {m === 99 ? "All" : m + "m"}
                    </button>
                  ))}
                </div>
              }>
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={shown}>
                    <defs>
                      <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.ind} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={C.ind} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={C.line} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: C.faint }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={ax} tick={{ fontSize: 11, fill: C.faint }} axisLine={false} tickLine={false} width={46} />
                    <Tooltip content={<TT />} />
                    <Area type="monotone" dataKey="revenue" stroke={C.ind} strokeWidth={2} fill="url(#g1)" />
                  </AreaChart>
                </ResponsiveContainer>
              </Card>

              <Card title="Receivables split">
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={segPie} dataKey="value" nameKey="name" cx="50%" cy="50%"
                         innerRadius={52} outerRadius={82} paddingAngle={2} stroke="none">
                      {segPie.map((_, i) => <Cell key={i} fill={i === 0 ? C.amb : C.cyn} />)}
                    </Pie>
                    <Tooltip content={<TT money />} />
                    <Legend wrapperStyle={{ fontSize: 12, color: C.dim }} />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ display: "flex", justifyContent: "space-around", marginTop: 4 }}>
                  <MiniStat label="Retail" value={rs(retail.total)} sub={`${N(retail.parties)} parties`} color={C.amb} />
                  <MiniStat label="Distribution" value={rs(dist.total)} sub={`${N(dist.parties)} parties`} color={C.cyn} />
                </div>
              </Card>
            </Two>

            <Two>
              <Card title="Top customers">
                <Rank rows={d.cust.slice(0, 8).map(r => ({
                  name: r.customer, value: rs(r.revenue), sub: `${N(r.invoices)} bills`, n: N(r.revenue)
                }))} />
              </Card>
              <Card title="Sales by product group">
                <Rank rows={d.sgrp.slice(0, 8).map(r => ({
                  name: r.product_group, value: rs(r.revenue), sub: `${Math.round(N(r.qty)).toLocaleString("en-IN")} qty`, n: N(r.revenue)
                }))} />
              </Card>
            </Two>
          </Col>
        )}

        {tab === "Revenue" && (
          <Col>
            <Grid min={190}>
              <Stat label="All-time revenue" value={rs(totalRev)} sub={`${totalInv.toLocaleString("en-IN")} invoices`} accent={C.ind} />
              <Stat label="This FY" value={rs(fyRev)} accent={C.grn} />
              <Stat label={cur.label} value={rs(cur.revenue)} sub={`${N(cur.invoices)} invoices`} accent={C.amb} />
              <Stat label="Avg invoice" value={rs(totalInv ? totalRev / totalInv : 0)} accent={C.dim} />
            </Grid>
            <Card title="Monthly revenue">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={shown}>
                  <CartesianGrid stroke={C.line} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: C.faint }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={ax} tick={{ fontSize: 11, fill: C.faint }} axisLine={false} tickLine={false} width={50} />
                  <Tooltip content={<TT />} />
                  <Bar dataKey="revenue" radius={[4, 4, 0, 0]}>
                    {shown.map((_, i) => <Cell key={i} fill={i === shown.length - 1 ? C.amb : C.ind} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>
            <Card title="Daily revenue — last 90 days">
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={daily}>
                  <defs>
                    <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.grn} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={C.grn} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={C.line} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: C.faint }} axisLine={false} tickLine={false} interval={6} />
                  <YAxis tickFormatter={ax} tick={{ fontSize: 11, fill: C.faint }} axisLine={false} tickLine={false} width={46} />
                  <Tooltip content={<TT />} />
                  <Area type="monotone" dataKey="revenue" stroke={C.grn} strokeWidth={2} fill="url(#g2)" />
                </AreaChart>
              </ResponsiveContainer>
            </Card>
          </Col>
        )}

        {tab === "Receivables" && (
          <Col>
            <Grid min={190}>
              <Stat label="Total receivables" value={rs(totalRecv)} sub={`${recvParties} parties`} accent={C.amb} />
              <Stat label="Retail" value={rs(retail.total)} sub={`${N(retail.parties)} parties`} accent={C.amb} />
              <Stat label="Distribution" value={rs(dist.total)} sub={`${N(dist.parties)} parties`} accent={C.cyn} />
              <Stat label="Payables" value={rs(Math.abs(payable))} accent={C.vio} />
            </Grid>

            <Card title="Outstanding by route / group">
              <ResponsiveContainer width="100%" height={Math.max(300, d.droute.slice(0, 20).length * 26)}>
                <BarChart data={d.droute.slice(0, 20).map(r => ({ ...r, total: N(r.total) }))}
                          layout="vertical" margin={{ left: 8, right: 24 }}>
                  <CartesianGrid stroke={C.line} strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tickFormatter={ax} tick={{ fontSize: 10, fill: C.faint }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="group_name" tick={{ fontSize: 11, fill: C.text }}
                         width={165} axisLine={false} tickLine={false} />
                  <Tooltip content={<TT />} />
                  <Bar dataKey="total" radius={[0, 4, 4, 0]}>
                    {d.droute.slice(0, 20).map((r, i) => (
                      <Cell key={i} fill={r.segment === "Retail" ? C.amb : C.cyn} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <Legendish items={[["Retail", C.amb], ["Distribution", C.cyn]]} />
            </Card>

            <Card title="All routes & groups">
              <Table
                head={["Group", "Segment", "Parties", "Outstanding"]}
                align={["left", "left", "right", "right"]}
                rows={d.droute.map(r => [
                  r.group_name,
                  <Pill key="s" text={r.segment} color={r.segment === "Retail" ? C.amb : C.cyn} />,
                  N(r.parties),
                  <b key="t" style={{ color: C.text }}>{rs(r.total)}</b>,
                ])}
              />
            </Card>
          </Col>
        )}

        {tab === "Customers" && (
          <Col>
            <Card title="Top 25 customers by revenue">
              <ResponsiveContainer width="100%" height={620}>
                <BarChart data={d.cust.map(r => ({ ...r, revenue: N(r.revenue) }))}
                          layout="vertical" margin={{ left: 8, right: 24 }}>
                  <CartesianGrid stroke={C.line} strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tickFormatter={ax} tick={{ fontSize: 10, fill: C.faint }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="customer" tick={{ fontSize: 10, fill: C.text }}
                         width={175} axisLine={false} tickLine={false} />
                  <Tooltip content={<TT />} />
                  <Bar dataKey="revenue" fill={C.ind} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>
            <Card title="Customer detail">
              <Table
                head={["#", "Customer", "Revenue", "Invoices", "Avg bill"]}
                align={["right", "left", "right", "right", "right"]}
                rows={d.cust.map((r, i) => [
                  i + 1, r.customer,
                  <b key="r" style={{ color: C.grn }}>{rs(r.revenue)}</b>,
                  N(r.invoices),
                  rs(N(r.revenue) / Math.max(N(r.invoices), 1)),
                ])}
              />
            </Card>
          </Col>
        )}

        {tab === "Products" && (
          <Col>
            <Card title="Revenue by product group">
              <ResponsiveContainer width="100%" height={Math.max(320, d.sgrp.slice(0, 22).length * 24)}>
                <BarChart data={d.sgrp.slice(0, 22).map(r => ({ ...r, revenue: N(r.revenue) }))}
                          layout="vertical" margin={{ left: 8, right: 24 }}>
                  <CartesianGrid stroke={C.line} strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tickFormatter={ax} tick={{ fontSize: 10, fill: C.faint }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="product_group" tick={{ fontSize: 10, fill: C.text }}
                         width={185} axisLine={false} tickLine={false} />
                  <Tooltip content={<TT />} />
                  <Bar dataKey="revenue" radius={[0, 4, 4, 0]}>
                    {d.sgrp.slice(0, 22).map((_, i) => <Cell key={i} fill={PAL[i % PAL.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>
            <Card title="Top 25 items">
              <Table
                head={["#", "Item", "Group", "Revenue", "Qty"]}
                align={["right", "left", "left", "right", "right"]}
                rows={d.items.map((r, i) => [
                  i + 1, r.item_name,
                  <span key="g" style={{ color: C.dim, fontSize: 12 }}>{r.product_group}</span>,
                  <b key="r" style={{ color: C.grn }}>{rs(r.revenue)}</b>,
                  Math.round(N(r.qty)).toLocaleString("en-IN"),
                ])}
              />
            </Card>
          </Col>
        )}

        {tab === "Inventory" && (
          <Col>
            <Grid min={190}>
              <Stat label="Stock value" value={rs(stockVal)} accent={C.cyn} />
              <Stat label="SKUs in stock" value={skus.toLocaleString("en-IN")} accent={C.ind} />
              <Stat label="Product groups" value={d.stock.length} accent={C.dim} />
            </Grid>
            <Two>
              <Card title="Stock value by group">
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie data={d.stock.slice(0, 9).map(r => ({ name: r.product_group, value: N(r.stock_value) }))}
                         dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} stroke="none">
                      {d.stock.slice(0, 9).map((_, i) => <Cell key={i} fill={PAL[i % PAL.length]} />)}
                    </Pie>
                    <Tooltip content={<TT money />} />
                  </PieChart>
                </ResponsiveContainer>
              </Card>
              <Card title="Breakdown">
                <Rank rows={d.stock.slice(0, 10).map(r => ({
                  name: r.product_group, value: rs(r.stock_value), sub: `${N(r.skus)} SKUs`, n: N(r.stock_value)
                }))} />
              </Card>
            </Two>
            <Card title="All groups">
              <Table
                head={["Group", "SKUs", "Stock value"]}
                align={["left", "right", "right"]}
                rows={d.stock.map(r => [
                  r.product_group, N(r.skus),
                  <b key="v" style={{ color: C.text }}>{rs(r.stock_value)}</b>,
                ])}
              />
            </Card>
          </Col>
        )}

        <p style={{ color: C.faint, fontSize: 11, marginTop: 22, lineHeight: 1.6 }}>
          Live from Busy ERP via Supabase. Receivables reconcile to within ~0.6% of Busy's Amount Receivable report;
          three accounts are known to differ and are tracked separately.
        </p>
      </div>
    </Shell>
  );
}

const hamburgerStyle = {
  fontSize: 18, padding: "6px 10px", lineHeight: 1, border: "none",
  background: "none", color: C.text, cursor: "pointer",
};

const Shell = ({ children }) => (
  <div style={{ background: C.bg, minHeight: "100vh", color: C.text,
                fontFamily: "'Inter',system-ui,-apple-system,sans-serif", fontSize: 14 }}>
    {children}
  </div>
);

const Msg = ({ t, s }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", textAlign: "center" }}>
    <div>
      <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>{t}</div>
      <div style={{ color: C.dim, fontSize: 13 }}>{s}</div>
    </div>
  </div>
);

const Col = ({ children }) => <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>;
const Grid = ({ children, min = 200 }) => (
  <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit,minmax(${min}px,1fr))`, gap: 12 }}>{children}</div>
);
const Two = ({ children }) => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 16 }}>{children}</div>
);

const btn = (on) => ({
  padding: "4px 10px", fontSize: 11, borderRadius: 5, cursor: "pointer", border: "none",
  background: on ? C.ind : "#232735", color: on ? "#fff" : C.dim, fontFamily: "inherit",
});

const Card = ({ title, right, children }) => (
  <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", color: C.dim }}>{title}</span>
      {right}
    </div>
    {children}
  </div>
);

const Stat = ({ label, value, sub, accent }) => (
  <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: "16px 18px",
                borderLeft: `3px solid ${accent || C.ind}` }}>
    <div style={{ fontSize: 11, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
    <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: C.faint, marginTop: 3 }}>{sub}</div>}
  </div>
);

const MiniStat = ({ label, value, sub, color }) => (
  <div style={{ textAlign: "center" }}>
    <div style={{ fontSize: 11, color: C.dim }}>{label}</div>
    <div style={{ fontSize: 16, fontWeight: 600, color }}>{value}</div>
    <div style={{ fontSize: 10, color: C.faint }}>{sub}</div>
  </div>
);

const Rank = ({ rows }) => {
  const max = Math.max(...rows.map(r => r.n), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      {rows.map((r, i) => (
        <div key={i}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
            <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{r.value}</span>
          </div>
          <div style={{ height: 4, background: "#20242f", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(r.n / max) * 100}%`, background: PAL[i % PAL.length], borderRadius: 2 }} />
          </div>
          {r.sub && <div style={{ fontSize: 10, color: C.faint, marginTop: 2 }}>{r.sub}</div>}
        </div>
      ))}
    </div>
  );
};

const Table = ({ head, rows, align = [] }) => (
  <div style={{ overflowX: "auto", maxHeight: 460, overflowY: "auto" }}>
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr>{head.map((h, i) => (
          <th key={i} style={{ position: "sticky", top: 0, background: C.card, textAlign: align[i] || "left",
                               padding: "8px 10px", color: C.dim, fontWeight: 500, fontSize: 11,
                               letterSpacing: ".06em", textTransform: "uppercase",
                               borderBottom: `1px solid ${C.line}` }}>{h}</th>
        ))}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{r.map((c, j) => (
            <td key={j} style={{ padding: "9px 10px", textAlign: align[j] || "left",
                                 borderBottom: "1px solid #1c202b", color: C.text }}>{c}</td>
          ))}</tr>
        ))}
      </tbody>
    </table>
  </div>
);

const Pill = ({ text, color }) => (
  <span style={{ fontSize: 11, padding: "2px 9px", borderRadius: 20, background: color + "22", color }}>{text}</span>
);

const Legendish = ({ items }) => (
  <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 10 }}>
    {items.map(([l, c]) => (
      <span key={l} style={{ fontSize: 11, color: C.dim, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 9, height: 9, borderRadius: 2, background: c }} />{l}
      </span>
    ))}
  </div>
);

const TT = ({ active, payload, label, money }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div style={{ background: "#1c2029", border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 13px" }}>
      <div style={{ color: C.dim, fontSize: 11, marginBottom: 3 }}>{label || p.name}</div>
      <div style={{ fontWeight: 700, fontSize: 14 }}>{rs(p.value)}</div>
      {p.payload?.invoices != null && !money && (
        <div style={{ color: C.faint, fontSize: 11, marginTop: 2 }}>{N(p.payload.invoices)} invoices</div>
      )}
    </div>
  );
};
