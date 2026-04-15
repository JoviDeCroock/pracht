export const RENDER_MODE = "ssg";

export default function AliceProfile() {
  return (
    <section>
      <h1>@alice</h1>
      <p>Static handles that start with @ should stay routable in dev.</p>
    </section>
  );
}
