import { useState, useEffect } from 'react';

export default function GitHubStars() {
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    fetch('https://api.github.com/repos/backnotprop/plannotator')
      .then((r) => r.json())
      .then((data) => {
        if (data.stargazers_count) setStars(data.stargazers_count);
      })
      .catch(() => {});
  }, []);

  if (stars === null) return <span>Star on GitHub</span>;

  return (
    <span className="inline-flex items-center gap-1">
      <svg className="w-3 h-3 text-accent" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 .587l3.668 7.568L24 9.306l-6 5.848 1.417 8.259L12 19.446l-7.417 3.967L6 15.154 0 9.306l8.332-1.151z" />
      </svg>
      {stars.toLocaleString()} stars
    </span>
  );
}
