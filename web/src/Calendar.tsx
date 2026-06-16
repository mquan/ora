import { useEffect, useMemo, useRef } from "react";
import {
  type CalendarItem,
  weekDays,
  monthMatrix,
  itemsForDay,
  blockPosition,
  dayFraction,
  sameDay,
  addDays,
  startOfDay,
} from "./calendarModel";

export type CalendarView = "week" | "month" | "agenda";

interface CalendarProps {
  view: CalendarView;
  anchor: Date;
  items: CalendarItem[];
  now: Date;
  onSelect: (eventId: string) => void;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayNumFmt = new Intl.DateTimeFormat(undefined, { day: "numeric" });
const fullDayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

export function Calendar(props: CalendarProps) {
  if (props.view === "week") return <WeekView {...props} />;
  if (props.view === "month") return <MonthView {...props} />;
  return <AgendaView {...props} />;
}

/** Greedy lane assignment so overlapping blocks in a day sit side-by-side instead of hiding each other. */
function withLanes(items: CalendarItem[]): { item: CalendarItem; lane: number; lanes: number }[] {
  const sorted = [...items].sort((a, b) => a.start.getTime() - b.start.getTime());
  const laneEnds: number[] = [];
  const placed = sorted.map((item) => {
    let lane = laneEnds.findIndex((end) => end <= item.start.getTime());
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end.getTime());
    } else {
      laneEnds[lane] = item.end.getTime();
    }
    return { item, lane };
  });
  const lanes = Math.max(1, laneEnds.length);
  return placed.map((p) => ({ ...p, lanes }));
}

function Block({ item, style, onSelect }: { item: CalendarItem; style: React.CSSProperties; onSelect: (id: string) => void }) {
  return (
    <button
      className={`block status-${item.status} ${item.live ? "live" : ""}`}
      style={style}
      title={`${item.title} — ${item.status}`}
      onClick={() => onSelect(item.eventId)}
    >
      <span className="block-time">{timeFmt.format(item.start)}</span>
      <span className="block-title">{item.title}</span>
    </button>
  );
}

function WeekView({ anchor, items, now, onSelect }: CalendarProps) {
  const days = useMemo(() => weekDays(anchor), [anchor]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // On first paint (and when the week changes), scroll so the current/working hours are visible.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const target = Math.max(0, dayFraction(now) * el.scrollHeight - el.clientHeight / 2);
    el.scrollTop = target;
    // Only re-run when the visible week changes, not every clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  return (
    <div className="week">
      <div className="week-head">
        <div className="gutter-head" />
        {days.map((d) => (
          <div key={d.toISOString()} className={`day-head ${sameDay(d, now) ? "is-today" : ""}`}>
            <span className="dow">{weekdayFmt.format(d)}</span>
            <span className="dnum">{dayNumFmt.format(d)}</span>
          </div>
        ))}
      </div>
      <div className="week-body" ref={scrollRef}>
        <div className="gutter">
          {HOURS.map((h) => (
            <div key={h} className="hour-label">
              <span>{hourFmt.format(new Date(2000, 0, 1, h))}</span>
            </div>
          ))}
        </div>
        {days.map((day) => {
          const laned = withLanes(itemsForDay(items, day));
          const isToday = sameDay(day, now);
          return (
            <div key={day.toISOString()} className={`day-col ${isToday ? "is-today" : ""}`}>
              {HOURS.map((h) => (
                <div key={h} className="hour-cell" />
              ))}
              {laned.map(({ item, lane, lanes }) => {
                const { topPct, heightPct } = blockPosition(item, day);
                const width = 100 / lanes;
                return (
                  <Block
                    key={item.id}
                    item={item}
                    onSelect={onSelect}
                    style={{
                      top: `${topPct}%`,
                      height: `${heightPct}%`,
                      left: `calc(${lane * width}% + 2px)`,
                      width: `calc(${width}% - 4px)`,
                    }}
                  />
                );
              })}
              {isToday && <div className="now-line" style={{ top: `${dayFraction(now) * 100}%` }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MonthView({ anchor, items, now, onSelect }: CalendarProps) {
  const weeks = useMemo(() => monthMatrix(anchor), [anchor]);
  const month = anchor.getMonth();
  const MAX_CHIPS = 3;
  return (
    <div className="month">
      <div className="month-head">
        {weekDays(anchor).map((d) => (
          <div key={d.toISOString()} className="month-dow">
            {weekdayFmt.format(d)}
          </div>
        ))}
      </div>
      <div className="month-grid">
        {weeks.flat().map((day) => {
          const dayItems = itemsForDay(items, day);
          const outside = day.getMonth() !== month;
          return (
            <div key={day.toISOString()} className={`mcell ${outside ? "outside" : ""} ${sameDay(day, now) ? "is-today" : ""}`}>
              <div className="mcell-num">{dayNumFmt.format(day)}</div>
              <div className="chips">
                {dayItems.slice(0, MAX_CHIPS).map((item) => (
                  <button
                    key={item.id}
                    className={`chip status-${item.status} ${item.live ? "live" : ""}`}
                    title={`${item.title} — ${item.status}`}
                    onClick={() => onSelect(item.eventId)}
                  >
                    <span className="chip-time">{timeFmt.format(item.start)}</span> {item.title}
                  </button>
                ))}
                {dayItems.length > MAX_CHIPS && (
                  <div className="more">+{dayItems.length - MAX_CHIPS} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgendaView({ anchor, items, now, onSelect }: CalendarProps) {
  // Show a rolling window from the start of the anchor week onward, grouped by day.
  const windowStart = startOfDay(addDays(anchor, -1));
  const upcoming = items
    .filter((it) => it.start.getTime() >= windowStart.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const groups = useMemo(() => {
    const byDay = new Map<string, CalendarItem[]>();
    for (const it of upcoming) {
      const key = startOfDay(it.start).toISOString();
      const list = byDay.get(key);
      if (list) list.push(it);
      else byDay.set(key, [it]);
    }
    return [...byDay.entries()];
  }, [upcoming]);

  if (groups.length === 0) {
    return (
      <div className="agenda empty-state">
        <p>No runs scheduled or recorded in this range.</p>
        <p className="muted">Use “＋ New run” to schedule one — it’ll appear here and on the calendar.</p>
      </div>
    );
  }

  return (
    <div className="agenda">
      {groups.map(([key, dayItems]) => {
        const day = new Date(key);
        return (
          <section key={key} className="agenda-day">
            <h3 className={sameDay(day, now) ? "is-today" : ""}>{fullDayFmt.format(day)}</h3>
            {dayItems.map((item) => (
              <button key={item.id} className="agenda-row" onClick={() => onSelect(item.eventId)}>
                <span className="agenda-time">{timeFmt.format(item.start)}</span>
                <span className={`pill status-${item.status} ${item.live ? "live" : ""}`}>{item.status}</span>
                <span className="agenda-title">{item.title}</span>
                <span className="agenda-engine muted">{item.engine}</span>
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}
