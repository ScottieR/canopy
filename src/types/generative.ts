export interface GenerativeResult {
  versionId: string;
  userPrompt: string;
  compiledImageUrl: string;
  dynamicParams: {
    color: string;
    robeColor: string;
    accentColor: string;
    habitatColor: string;
    habitatLabel: string;
    accessories: string[];
  };
}
