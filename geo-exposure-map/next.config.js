/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  basePath: "/FactSet_Revenue_by_Country",
  assetPrefix: "/FactSet_Revenue_by_Country/",
};

module.exports = nextConfig;
