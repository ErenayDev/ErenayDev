import { defineConfig, tierPresets } from "sponsorkit";

export default defineConfig({
  github: {
    login: "ErenayDev",
    type: "user",
  },
  includePastSponsors: true,
  includePrivate: true,
  force: true,
  providers: ["github"],
  width: 800,
  formats: ["json", "svg", "png"],
  tiers: [
    {
      title: "Past Sponsors",
      monthlyDollars: -1,
      preset: tierPresets.xs,
    },
    {
      title: "Backers",
      preset: tierPresets.base,
    },
    {
      title: "Sponsors",
      monthlyDollars: 10,
      preset: tierPresets.medium,
    },
    {
      title: "Silver Sponsors",
      monthlyDollars: 25,
      preset: tierPresets.large,
    },
    {
      title: "Gold Sponsors",
      monthlyDollars: 100,
      preset: tierPresets.xl,
    },
  ],
});
