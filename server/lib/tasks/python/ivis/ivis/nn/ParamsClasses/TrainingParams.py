from .RunParams import RunParams


class TrainingParams(RunParams):
    """Class representing the parameters for `run_training` function."""

    def __init__(self):
        super().__init__(None)

        self.split = dict()          # Fractions of the dataset to use as training, validation and test datasets. Should sum up to 1.
