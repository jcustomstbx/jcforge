import "./PlaceholderScreen.css";

interface PlaceholderScreenProps {
  title: string;
  subtitle: string;
}

export function PlaceholderScreen({ title, subtitle }: PlaceholderScreenProps) {
  return (
    <div className="placeholder-screen">
      <h1 className="placeholder-screen__title">{title}</h1>
      <p className="placeholder-screen__subtitle">{subtitle}</p>
    </div>
  );
}
