package Vehicle {
    import ScalarValues::*;

    part def Vehicle {
        part chassis : Chassis;
        part wheels[4] : Wheel;
    }

    part def Chassis {
        attribute frameMass : Real = 120.0;
    }

    part def Wheel {
        attribute radius : Real = 0.3;
    }

    requirement def MassRequirement {
        attribute text : String = "The vehicle mass shall not exceed 2000 kg.";
    }

    verification def MassVerification {
        subject v : Vehicle;
        objective {
            verify MassRequirement;
        }
    }
}
