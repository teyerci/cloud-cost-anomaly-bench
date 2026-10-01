import type { InfrastructureEvent } from "../types";

type Props = {
  events: InfrastructureEvent[];
};

export function EventTimeline({ events }: Props) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Event Timeline</h2>
        <span>{events.length} events</span>
      </div>
      <div className="timeline">
        {events.map((event) => (
          <article className="event" key={event.id}>
            <div className="event-time">{new Date(event.timestamp).toLocaleString()}</div>
            <strong>{event.eventType}</strong>
            <p>{event.description}</p>
            <small>{event.account} / {event.service} / {event.region}</small>
          </article>
        ))}
      </div>
    </section>
  );
}
