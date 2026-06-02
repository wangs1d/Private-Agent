import { useEffect, useState } from "react";
import "../modes/modes.css";

export function EntranceAnimation() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 3000);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className="entrance-animation">
      <div className="entrance-black-screen" />
      <div className="entrance-light" />
      <div className="entrance-halo" />
    </div>
  );
}
